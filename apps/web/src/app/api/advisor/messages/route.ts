import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { AdvisorUnavailableError, runAdvisorTurn, type AdvisorTurnEvent } from '@arfolio/mcp';
import { claimChatTurn, isAiAvailable } from '@arfolio/services';
import { getBrand } from '@/lib/brand';
import { getAdvisorLimits } from '@/server/advisor-data';
import { createClient } from '@/server/advisor-client';
import { loadAiEnabled, loadHouseholdFormat } from '@/server/household-format';
import { getIntegrationConfig } from '@/server/integration-config';
import { getSessionContext } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';

export const dynamic = 'force-dynamic';

const bodySchema = z.strictObject({ text: z.string().min(1).max(4000) });

const json = (status: number, body: Record<string, string>): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const toFrame = (e: AdvisorTurnEvent): string =>
  e.type === 'text'
    ? frame('text', { delta: e.delta })
    : e.type === 'tool'
      ? frame('tool', { name: e.name })
      : frame('proposal', { proposal: e.proposal });

/**
 * One chat turn with the advisor, streamed as server-sent events (`text`, `tool`, `proposal`,
 * then `done` or `error`; 429 daily_limit and 409 busy before it). The model call is aborted when the browser disconnects. Nothing the
 * member wrote or the model answered is logged: only the class of a failure.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const session = await getSessionContext(request.headers);
  if (!session) return json(401, { error: 'unauthenticated' });
  const ctx = toServiceCtx(session);

  const cfg = await getIntegrationConfig();
  const apiKey = cfg.anthropicApiKey.value;
  const model = cfg.models.advisor.value;
  if (!isAiAvailable(cfg) || apiKey === undefined || !(await loadAiEnabled(ctx))) {
    return json(403, { error: 'ai_off' });
  }
  if (model === undefined) return json(503, { error: 'unavailable' });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { error: 'invalid_input' });

  const limits = getAdvisorLimits();
  const [format, client] = [await loadHouseholdFormat(ctx), createClient(apiKey)];

  // Checks the cap and stores the member's message in one step: concurrent posts cannot slip past.
  const claim = await claimChatTurn(ctx, {
    text: parsed.data.text,
    dailyLimit: limits.dailyMessages,
    now: new Date(),
  });
  if ('refused' in claim) {
    return claim.refused === 'daily_limit'
      ? json(429, { error: 'daily_limit' })
      : json(409, { error: 'busy' });
  }

  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      try {
        const result = await runAdvisorTurn(
          {
            ctx,
            client,
            model,
            limits,
            brandName: getBrand().name,
            locale: format.locale,
            currency: format.currency,
          },
          { kind: 'chat', text: parsed.data.text, userMessageId: claim.userMessageId },
          (event) => send(toFrame(event)),
          request.signal,
        );
        if ('messageId' in result) send(frame('done', { messageId: result.messageId }));
        else send(frame('error', { code: 'unavailable' }));
      } catch (error) {
        if (!request.signal.aborted) {
          console.error(
            `advisor turn failed: ${error instanceof AdvisorUnavailableError ? error.name : 'unexpected error'}`,
          );
        }
        send(frame('error', { code: 'unavailable' }));
      } finally {
        if (open) controller.close();
        open = false;
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      // Keeps a reverse proxy from buffering the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
