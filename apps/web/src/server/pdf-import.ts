import {
  assertCanWrite,
  assertPdfStatementFile,
  createAnthropicClient,
  extractPdfStatement,
  listAccounts,
  NotFoundError,
  PDF_STATEMENT_MAPPING,
  ValidationError,
  type ColumnMapping,
  type ServiceCtx,
} from '@arfolio/services';
import { createRateLimiter } from '../lib/rate-limit';
import { getIntegrationConfig } from './integration-config';
import { loadAiEnabled } from './household-format';

export type PdfExtractionDto = {
  csv: string;
  filename: string;
  mapping: ColumnMapping;
  rows: number;
};

export type PdfImportDeps = {
  getConfig: typeof getIntegrationConfig;
  loadAiEnabled: typeof loadAiEnabled;
  createClient: typeof createAnthropicClient;
  limiter: { take(key: string): boolean };
  extract: typeof extractPdfStatement;
};

/** Ten extractions per household per hour (per process): each one is a paid model call. */
const defaultLimiter = createRateLimiter({ max: 10, windowMs: 3_600_000 });

// The service logs result codes and counts only.
const logger = {
  info: (message: string) => console.info(message),
  warn: (message: string) => console.warn(message),
};

/**
 * Reads a PDF statement with AI for the import wizard. Every gate runs on the server and before
 * the model is reached: write role, per-file confirmation, installation key, household AI switch,
 * the account, the file's PDF signature and size, then the hourly limit. The slot is taken
 * before the call, so a failed extraction still counts.
 */
export async function extractPdfForImport(
  ctx: ServiceCtx,
  input: {
    accountId: string;
    file: { buffer: Buffer; filename: string };
    confirmed: boolean;
  },
  deps: Partial<PdfImportDeps> = {},
): Promise<PdfExtractionDto> {
  assertCanWrite(ctx);
  if (!input.confirmed) {
    throw new ValidationError('A confirmation is required before a PDF is sent');
  }
  const cfg = await (deps.getConfig ?? getIntegrationConfig)();
  const apiKey = cfg.anthropicApiKey.value;
  if (!apiKey || !(await (deps.loadAiEnabled ?? loadAiEnabled)(ctx))) {
    throw new ValidationError('AI is not available for this household');
  }
  const account = (await listAccounts(ctx)).find((a) => a.id === input.accountId);
  if (!account) throw new NotFoundError('Account');
  // A wrong file must not use up one of the hourly extractions.
  assertPdfStatementFile(input.file.buffer);
  if (!(deps.limiter ?? defaultLimiter).take(ctx.householdId)) {
    throw new ValidationError('Too many PDF statements were sent in the last hour');
  }
  // A model setting always has a default; an undefined one means the config is broken.
  const model = cfg.models.import.value;
  if (model === undefined) throw new Error('AI model is not configured');
  const { csv, rows } = await (deps.extract ?? extractPdfStatement)(
    {
      anthropic: (deps.createClient ?? createAnthropicClient)(apiKey),
      model,
      logger,
    },
    { pdf: input.file.buffer, accountCurrency: account.currency },
  );
  return { csv, mapping: PDF_STATEMENT_MAPPING, rows, filename: `${input.file.filename}.csv` };
}
