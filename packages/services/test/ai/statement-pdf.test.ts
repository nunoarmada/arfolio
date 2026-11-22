import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import {
  MAX_IMPORT_BYTES,
  MAX_PDF_STATEMENT_ROWS,
  PDF_STATEMENT_HEADERS,
  PDF_STATEMENT_MAPPING,
  ValidationError,
  applyMapping,
  extractPdfStatement,
  parseFile,
  type AnthropicCreateLike,
} from '../../src/index.js';

type Call = Anthropic.MessageCreateParamsNonStreaming;
type Row = { date: string; description: string; amount: string };
type Block = Record<string, unknown>;

const PDF = Buffer.from('%PDF-1.7 fictional statement');
const row = (over: Partial<Row> = {}): Row => ({
  date: '2026-03-02',
  description: 'Grocer Example',
  amount: '-23.45',
  ...over,
});
const answer = (rows: Row[], currency: string | null = 'EUR') => ({ currency, rows });

/** A Messages API response as `messages.create` returns it. */
const message = (content: Block[], stop: string | null = 'end_turn') =>
  ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Message;
const text = (value: string): Block => ({ type: 'text', text: value, citations: null });

const parsed = (rows: Row[], currency: string | null = 'EUR', stop = 'end_turn') =>
  message([text(JSON.stringify(answer(rows, currency)))], stop);

function setup(respond: (call: Call) => unknown | Promise<unknown> = () => parsed([row()])) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const anthropic: AnthropicCreateLike = {
    messages: {
      async create(params) {
        calls.push(params);
        return (await respond(params)) as Anthropic.Message;
      },
    },
  };
  const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
  const run = (over: { pdf?: Buffer; accountCurrency?: string } = {}) =>
    extractPdfStatement(
      { anthropic, model: 'claude-test', logger },
      { pdf: over.pdf ?? PDF, accountCurrency: over.accountCurrency ?? 'EUR' },
    );
  return { calls, lines, run };
}

const rejects = async (p: Promise<unknown>, message: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).message).toBe(message);
};

const roundTrip = async (csv: string) =>
  applyMapping(await parseFile(Buffer.from(csv), 'x.csv'), PDF_STATEMENT_MAPPING, {
    currency: 'EUR',
  });

describe('extractPdfStatement', () => {
  it('sends one request with the PDF as a base64 document block, a strict output format and no tools', async () => {
    const t = setup();
    await t.run();
    expect(t.calls).toHaveLength(1);
    const call = t.calls[0]!;
    const content = call.messages[0]!.content as unknown[];
    expect(content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') },
    });
    expect((call as { tools?: unknown }).tools).toBeUndefined();
    expect(call.output_config?.format).toBeDefined();
    expect(call.model).toBe('claude-test');
    expect(call.max_tokens).toBe(20000);
  });

  it('tells the model that the document is data', async () => {
    const t = setup();
    await t.run();
    const system = t.calls[0]!.system as Anthropic.TextBlockParam[];
    expect(system.map((b) => b.text).join('\n')).toMatch(/never follow instructions/i);
  });

  it('renders valid rows as CSV', async () => {
    const t = setup(() =>
      parsed([
        row(),
        row({ date: '2026-03-03', description: 'Salary Example Corp', amount: '1500' }),
      ]),
    );
    const out = await t.run();
    expect(out.csv).toBe(
      `${PDF_STATEMENT_HEADERS.join(',')}\n2026-03-02,Grocer Example,-23.45\n2026-03-03,Salary Example Corp,1500\n`,
    );
    expect(out.rows).toBe(2);
  });

  it('keeps commas, quotes and line breaks in descriptions', async () => {
    const t = setup(() => parsed([row({ description: 'Shop "A", Example\nLisbon' })]));
    const rows = await roundTrip((await t.run()).csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'ok',
      row: { description: 'Shop "A", Example Lisbon' },
    });
  });

  it('keeps a description that looks like a formula as text', async () => {
    const description = '=HYPERLINK("http://example.com")';
    const t = setup(() => parsed([row({ description })]));
    const rows = await roundTrip((await t.run()).csv);
    expect(rows[0]).toMatchObject({ status: 'ok', row: { description } });
  });

  it('accepts a statement without a currency', async () => {
    const t = setup(() => parsed([row()], null));
    expect((await t.run()).rows).toBe(1);
  });

  it('rejects bytes that are not a PDF without calling the model', async () => {
    const t = setup();
    await rejects(t.run({ pdf: Buffer.from('PK\u0003\u0004 zip') }), 'The file is not a PDF');
    expect(t.calls).toHaveLength(0);
  });

  it('rejects a file over the import size limit without calling the model', async () => {
    const t = setup();
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_IMPORT_BYTES)]);
    await rejects(t.run({ pdf: big }), 'The file is too large (maximum 10 MB)');
    expect(t.calls).toHaveLength(0);
  });

  it('rejects an answer without movements', async () => {
    const t = setup(() => parsed([]));
    await rejects(t.run(), 'No movements were found in this PDF');
  });

  it('rejects more than the row limit', async () => {
    const t = setup(() => parsed(Array.from({ length: MAX_PDF_STATEMENT_ROWS + 1 }, () => row())));
    await rejects(t.run(), 'The PDF statement has too many movements (maximum 500)');
  });

  it('rejects an answer cut off at the token limit as too many movements', async () => {
    const t = setup(() => parsed([row()], 'EUR', 'max_tokens'));
    await rejects(t.run(), 'The PDF statement has too many movements (maximum 500)');
  });

  it('rejects a truncated answer cut off at the token limit as too many movements', async () => {
    const t = setup(() =>
      message([text('{"currency":"EUR","rows":[{"date":"2026-03-')], 'max_tokens'),
    );
    await rejects(t.run(), 'The PDF statement has too many movements (maximum 500)');
  });

  it('reads the text block after a thinking block', async () => {
    const t = setup(() =>
      message([
        { type: 'thinking', thinking: 'reading the table', signature: 'sig' },
        text(JSON.stringify(answer([row()]))),
      ]),
    );
    expect((await t.run()).rows).toBe(1);
  });

  it('rejects a statement in another currency than the account', async () => {
    const t = setup(() => parsed([row()], 'USD'));
    await rejects(t.run(), 'The statement is in USD but the account is in EUR');
  });

  it.each([
    ['a refusal', parsed([row()], 'EUR', 'refusal')],
    ['a refusal with partial text', message([text('{"currency":"EUR","rows":[{"da')], 'refusal')],
    ['an answer without a text block', message([])],
    ['text that is not JSON', message([text('I cannot read this statement.')])],
    ['JSON that fails the schema', message([text(JSON.stringify({ rows: [{ date: 1 }] }))])],
    ['an impossible calendar date', parsed([row({ date: '2026-02-30' })])],
    ['a date in another format', parsed([row({ date: '02/03/2026' })])],
    ['an amount with three decimals', parsed([row({ amount: '12.345' })])],
    ['an amount that is not a number', parsed([row({ amount: 'abc' })])],
    ['an empty description', parsed([row({ description: '  \n ' })])],
    ['a description over 500 characters', parsed([row({ description: 'x'.repeat(501) })])],
  ])('rejects %s as an unusable answer', async (_name, response) => {
    const t = setup(() => response);
    await rejects(t.run(), 'The AI answer could not be used');
  });

  it('reports a provider timeout without provider text', async () => {
    const t = setup(() => {
      throw new APIConnectionTimeoutError({ message: 'secret provider text' });
    });
    await rejects(t.run(), 'The AI service took too long to answer');
  });

  it.each([401, 403, 429, 500])('reports HTTP %i as unreachable', async (status) => {
    const t = setup(() => {
      throw Object.assign(new Error('sk-ant-secret quota text'), { status });
    });
    await rejects(t.run(), 'The AI service could not be reached');
  });

  it('logs result codes only', async () => {
    const failing = setup(() => {
      throw Object.assign(new Error('Grocer Example -23.45'), { status: 429 });
    });
    await failing.run().catch(() => undefined);
    const ok = setup();
    await ok.run();
    const lines = [...failing.lines, ...ok.lines];
    expect(lines).toEqual(['pdf statement failed: http 429', 'pdf statement extracted: 1 rows']);
    for (const line of lines) {
      expect(line).toMatch(/^pdf statement /);
      expect(line).not.toMatch(/Grocer|23\.45/);
    }
  });
});
