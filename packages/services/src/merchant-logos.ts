import { and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import type { Db } from '@arfolio/db';
import { errorLabel, type AiLogger } from './ai/categorise.js';

const { merchant, merchantLogo } = schema;

/** Merchants per run (the hourly sweep picks up the rest). */
export const LOGO_MAX_PER_RUN = 50;
const REQUEST_TIMEOUT_MS = 10_000;
/** Largest response read; bigger ones are not a favicon. */
const MAX_BODY_BYTES = 100 * 1024;
/** The generic globe the favicon service answers with for unknown sites is smaller than this. */
const MIN_BODY_BYTES = 400;
/** Images this small or smaller are not worth showing. */
const MIN_SIDE_EXCLUSIVE = 16;
/** A `missing` row is tried again after this long. */
const RETRY_MISSING_AFTER_MS = 30 * 86_400_000;

export type FetchMerchantLogosDeps = {
  db: Db;
  /** Installation switch `MERCHANT_LOGOS`: false disables fetching entirely. */
  enabled: boolean;
  /** Receives counts and error classes only, never domains. */
  logger: AiLogger;
  /** Overrides for tests. */
  fetch?: typeof fetch;
  maxPerRun?: number;
};

export type FetchMerchantLogosResult = {
  status: 'done' | 'disabled' | 'unavailable';
  /** Merchants whose fetch ended in a verdict (`ok` or `missing`). */
  fetched: number;
  ok: number;
  missing: number;
};

type ImageType = 'image/png' | 'image/x-icon' | 'image/jpeg' | 'image/webp';
type Verdict = { kind: 'ok'; contentType: ImageType; bytes: Buffer } | { kind: 'missing' };

/** The image type from the first bytes, or null. SVG and anything unknown never match. */
function sniff(b: Buffer): ImageType | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => b[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x00, 0x00, 0x01, 0x00) && b.length >= 6 && b.readUInt16LE(4) >= 1) {
    return 'image/x-icon';
  }
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** The larger side in pixels for PNG and ICO (the formats the favicon service sends), else null. */
function largestSide(type: ImageType, b: Buffer): number | null {
  if (type === 'image/png') {
    return b.length >= 24 ? Math.max(b.readUInt32BE(16), b.readUInt32BE(20)) : null;
  }
  if (type === 'image/x-icon') {
    const count = b.readUInt16LE(4);
    let largest = 0;
    for (let i = 0; i < count && 6 + i * 16 + 2 <= b.length; i += 1) {
      const width = b[6 + i * 16]! || 256; // 0 stands for 256
      const height = b[7 + i * 16]! || 256;
      largest = Math.max(largest, width, height);
    }
    return largest || null;
  }
  return null;
}

class UnavailableError extends Error {}

/** Reads at most `MAX_BODY_BYTES`; null when the body is bigger (the stream is cancelled). */
async function readCapped(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
  } catch {
    throw new UnavailableError('favicon download was interrupted');
  }
  return Buffer.concat(parts);
}

/** Redirects are followed by hand, and only to the favicon service's own hosts over https. */
const MAX_REDIRECTS = 3;

function isAllowedTarget(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return host === 'google.com' || host.endsWith('.google.com') || host.endsWith('.gstatic.com');
}

async function fetchLogo(doFetch: typeof fetch, domain: string): Promise<Verdict> {
  let url = new URL(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
  );
  let res: Response;
  for (let hops = 0; ; hops += 1) {
    try {
      res = await doFetch(url.href, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new UnavailableError('favicon service is unreachable');
    }
    if (res.status < 300 || res.status >= 400) break;
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (!location || hops >= MAX_REDIRECTS) return { kind: 'missing' };
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return { kind: 'missing' };
    }
    if (!isAllowedTarget(next)) return { kind: 'missing' };
    url = next;
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    throw new UnavailableError(`favicon service answered ${res.status}`);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { kind: 'missing' };
  }
  const bytes = await readCapped(res);
  if (!bytes || bytes.length < MIN_BODY_BYTES) return { kind: 'missing' };
  const contentType = sniff(bytes);
  if (!contentType) return { kind: 'missing' };
  const side = largestSide(contentType, bytes);
  if (side !== null && side <= MIN_SIDE_EXCLUSIVE) return { kind: 'missing' };
  return { kind: 'ok', contentType, bytes };
}

/**
 * Fetches the favicon of merchants that have a domain and no logo yet (or a `missing` verdict
 * older than 30 days), at most 50 per run. The image comes from the favicon service, not from
 * the merchant's own site, and only a verified PNG, ICO, JPEG or WebP is stored. An unreachable
 * service ends the run without a verdict, so the next run tries again.
 */
export async function fetchMerchantLogos(
  deps: FetchMerchantLogosDeps,
  input: { householdId: string },
): Promise<FetchMerchantLogosResult> {
  const result: FetchMerchantLogosResult = { status: 'done', fetched: 0, ok: 0, missing: 0 };
  if (!deps.enabled) return { ...result, status: 'disabled' };
  const doFetch = deps.fetch ?? fetch;
  const { householdId } = input;
  const retryBefore = new Date(Date.now() - RETRY_MISSING_AFTER_MS);

  const due = await withHousehold(deps.db, householdId, (tx) =>
    tx
      .select({ id: merchant.id, domain: merchant.domain })
      .from(merchant)
      .leftJoin(
        merchantLogo,
        and(
          eq(merchantLogo.merchantId, merchant.id),
          eq(merchantLogo.householdId, merchant.householdId),
        ),
      )
      .where(
        and(
          eq(merchant.householdId, householdId),
          isNotNull(merchant.domain),
          or(
            isNull(merchantLogo.merchantId),
            and(eq(merchantLogo.status, 'missing'), lt(merchantLogo.fetchedAt, retryBefore)),
          ),
        ),
      )
      .orderBy(desc(merchant.createdAt), merchant.id)
      .limit(deps.maxPerRun ?? LOGO_MAX_PER_RUN),
  );

  for (const { id, domain } of due) {
    let verdict: Verdict;
    try {
      verdict = await fetchLogo(doFetch, domain!);
    } catch (err) {
      if (!(err instanceof UnavailableError)) throw err;
      deps.logger.warn(`merchant logos stopped: ${errorLabel(err)}`);
      result.status = 'unavailable';
      break;
    }
    const values =
      verdict.kind === 'ok'
        ? { status: 'ok' as const, contentType: verdict.contentType, bytes: verdict.bytes }
        : { status: 'missing' as const, contentType: null, bytes: null };
    try {
      await withHousehold(deps.db, householdId, (tx) =>
        tx
          .insert(merchantLogo)
          .values({ merchantId: id, householdId, ...values })
          .onConflictDoUpdate({
            target: merchantLogo.merchantId,
            set: { ...values, fetchedAt: new Date() },
          }),
      );
    } catch (err) {
      // The merchant was deleted while the image was downloading.
      const code = (e: unknown) => (e as { code?: unknown } | null)?.code;
      if (code(err) === '23503' || code((err as { cause?: unknown } | null)?.cause) === '23503') {
        continue;
      }
      throw err;
    }
    result.fetched += 1;
    if (verdict.kind === 'ok') result.ok += 1;
    else result.missing += 1;
  }
  deps.logger.info(
    `merchant logos: ${result.ok} stored, ${result.missing} missing` +
      (result.status === 'unavailable' ? ', stopped early' : ''),
  );
  return result;
}
