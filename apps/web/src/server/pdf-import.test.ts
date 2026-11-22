import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import {
  createAccount,
  ForbiddenError,
  MAX_IMPORT_BYTES,
  NotFoundError,
  PDF_STATEMENT_MAPPING,
  ValidationError,
  type ServiceCtx,
} from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createRateLimiter } from '../lib/rate-limit';
import { integrationConfigFixture } from '../test-utils';
import { extractPdfForImport, type PdfImportDeps } from './pdf-import';

const KEY = 'sk-ant-e2e-fake-key-0001';
const PDF = Buffer.from('%PDF-1.7 fictional');

describe('extractPdfForImport', () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let db: Db;
  let ctx: ServiceCtx;
  let accountId: string;

  async function household(): Promise<ServiceCtx> {
    const owner = createDb(testDb.ownerUrl, { max: 1 });
    const id = `hh_${randomUUID()}`;
    try {
      await owner.db.insert(schema.organization).values({
        id,
        name: 'Example household',
        slug: id,
        createdAt: new Date(),
      });
    } finally {
      await owner.pool.end();
    }
    await withHousehold(db, id, (tx) =>
      tx.insert(schema.householdSettings).values({ householdId: id, currency: 'USD' }),
    );
    return { db, householdId: id, userId: 'user-1', role: 'owner' };
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    db = app.db;
    close = async () => {
      await app.pool.end();
      await testDb.drop();
    };
    ctx = await household();
    const account = await createAccount(ctx, { name: 'Example Current', type: 'checking' });
    accountId = account.id;
  });
  afterAll(() => close());

  const extract = () =>
    vi.fn().mockResolvedValue({ csv: 'Date,Description,Amount\n2026-01-02,Shop,-1.50\n', rows: 1 });
  const makeDeps = (over: Partial<PdfImportDeps> = {}) => {
    const ex = extract();
    const createClient = vi.fn().mockReturnValue({ fake: 'client' });
    const deps = {
      getConfig: async () => integrationConfigFixture({ anthropicApiKey: KEY }),
      loadAiEnabled: async () => true,
      createClient,
      limiter: createRateLimiter({ max: 10, windowMs: 3_600_000 }),
      extract: ex,
      ...over,
    } as PdfImportDeps;
    return { deps, extract: deps.extract as typeof ex, createClient };
  };
  const input = (over: Record<string, unknown> = {}) => ({
    accountId,
    file: { buffer: PDF, filename: 'statement.pdf' },
    confirmed: true,
    ...over,
  });

  it('returns the CSV, the fixed mapping, the row count and the CSV file name', async () => {
    const { deps, extract: ex } = makeDeps();
    const dto = await extractPdfForImport(ctx, input(), deps);
    expect(dto).toEqual({
      csv: 'Date,Description,Amount\n2026-01-02,Shop,-1.50\n',
      mapping: PDF_STATEMENT_MAPPING,
      rows: 1,
      filename: 'statement.pdf.csv',
    });
    expect(ex).toHaveBeenCalledOnce();
  });

  it('builds the client from the API key and passes the import model and account currency', async () => {
    const { deps, extract: ex, createClient } = makeDeps();
    await extractPdfForImport(ctx, input(), deps);
    expect(createClient).toHaveBeenCalledWith(KEY);
    const [d, i] = ex.mock.calls[0]!;
    expect(d.model).toBe('claude-opus-5-5');
    expect(d.anthropic).toEqual({ fake: 'client' });
    expect(typeof d.logger.info).toBe('function');
    expect(typeof d.logger.warn).toBe('function');
    expect(i).toEqual({ pdf: PDF, accountCurrency: 'USD' });
  });

  it('rejects a read-only role before anything else', async () => {
    const { deps, extract: ex } = makeDeps({ loadAiEnabled: async () => false });
    await expect(
      extractPdfForImport({ ...ctx, role: 'viewer' }, input({ confirmed: false }), deps),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(ex).not.toHaveBeenCalled();
  });

  it('rejects without a confirmation', async () => {
    const { deps, extract: ex } = makeDeps();
    await expect(extractPdfForImport(ctx, input({ confirmed: false }), deps)).rejects.toThrow(
      new ValidationError('A confirmation is required before a PDF is sent'),
    );
    expect(ex).not.toHaveBeenCalled();
  });

  it('rejects when the installation has no API key', async () => {
    const { deps, extract: ex } = makeDeps({
      getConfig: async () => integrationConfigFixture(),
    });
    await expect(extractPdfForImport(ctx, input(), deps)).rejects.toThrow(
      'AI is not available for this household',
    );
    expect(ex).not.toHaveBeenCalled();
  });

  it('rejects when the household has AI switched off', async () => {
    const { deps, extract: ex } = makeDeps({ loadAiEnabled: async () => false });
    await expect(extractPdfForImport(ctx, input(), deps)).rejects.toThrow(
      'AI is not available for this household',
    );
    expect(ex).not.toHaveBeenCalled();
  });

  it('treats an unknown account as not found without calling the model', async () => {
    const { deps, extract: ex } = makeDeps();
    await expect(
      extractPdfForImport(ctx, input({ accountId: randomUUID() }), deps),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(ex).not.toHaveBeenCalled();
  });

  it.each([
    ['bytes that are not a PDF', Buffer.from('PK\u0003\u0004 zip'), 'The file is not a PDF'],
    [
      'a file over the size limit',
      Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_IMPORT_BYTES)]),
      'The file is too large (maximum 10 MB)',
    ],
  ])('rejects %s without taking a slot of the hourly limit', async (_name, buffer, message) => {
    const { deps, extract: ex } = makeDeps({
      limiter: createRateLimiter({ max: 1, windowMs: 3_600_000 }),
    });
    await expect(
      extractPdfForImport(ctx, input({ file: { buffer, filename: 'statement.pdf' } }), deps),
    ).rejects.toThrow(new ValidationError(message));
    expect(ex).not.toHaveBeenCalled();
    await expect(extractPdfForImport(ctx, input(), deps)).resolves.toMatchObject({ rows: 1 });
  });

  it('allows 10 extractions per household per hour, a failed one included', async () => {
    const other = await household();
    const otherAccount = await createAccount(other, { name: 'Other', type: 'checking' });
    const { deps, extract: ex } = makeDeps();
    ex.mockRejectedValueOnce(new ValidationError('The AI service could not be reached'));
    await expect(extractPdfForImport(ctx, input(), deps)).rejects.toThrow('could not be reached');
    for (let i = 0; i < 9; i++) await extractPdfForImport(ctx, input(), deps);
    expect(ex).toHaveBeenCalledTimes(10);
    await expect(extractPdfForImport(ctx, input(), deps)).rejects.toThrow(
      'Too many PDF statements were sent in the last hour',
    );
    expect(ex).toHaveBeenCalledTimes(10);
    await expect(
      extractPdfForImport(other, input({ accountId: otherAccount.id }), deps),
    ).resolves.toMatchObject({ rows: 1 });
  });
});
