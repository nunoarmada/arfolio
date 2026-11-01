import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import {
  parseTrading212ExportCsv,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '@arfolio/connectors';
import type { Db } from '@arfolio/db';
import {
  applyT212Export,
  findT212EnrichmentStart,
  openT212ExportClient,
  type ConnectorDeps,
} from '@arfolio/services';
import { registerJob } from '../boss.js';
import { errorMessage, log } from '../log.js';
import { QUEUES, T212_EXPORT_QUEUE_OPTIONS } from '../queues.js';

/** Seconds between polls of a pending export, and the floor for any retry after an error. */
const POLL_DELAY_SECONDS = 60;
/** About 20 minutes of polling: an export normally finishes within a few. */
export const T212_MAX_ATTEMPTS = 20;
const DAY_MS = 86_400_000;
/** One export covers at most a year. */
const MAX_RANGE_DAYS = 365;
/** Days a card payment may take to appear, with its merchant, in the export. */
const SETTLE_DAYS = 3;

/** Column names Trading 212 is known to use: only these are ever logged, by name. */
const KNOWN_COLUMNS = new Set(
  [
    'Action',
    'Time',
    'ISIN',
    'Ticker',
    'Name',
    'Notes',
    'ID',
    'No. of shares',
    'Price / share',
    'Currency (Price / share)',
    'Exchange rate',
    'Result',
    'Currency (Result)',
    'Total',
    'Currency (Total)',
    'Withholding tax',
    'Currency (Withholding tax)',
    'Charge amount',
    'Currency (Charge amount)',
    'Deposit fee',
    'Currency (Deposit fee)',
    'Currency conversion fee',
    'Currency (Currency conversion fee)',
    'Merchant name',
    'Merchant category',
    'Stamp duty reserve tax',
    'Currency (Stamp duty reserve tax)',
    'French transaction tax',
    'Currency (French transaction tax)',
  ].map((c) => c.toLowerCase()),
);

/** Known column names plus a count of the others: a header row that is really data stays out of the logs. */
function describeHeader(header: string[]): string {
  const known = header.filter((h) => KNOWN_COLUMNS.has(h.trim().toLowerCase()));
  const others = header.length - known.length;
  return `${known.join(', ') || 'no known columns'}${others > 0 ? ` (+${others} unknown)` : ''}`;
}

const payload = z.strictObject({
  householdId: z.string().min(1),
  connectionId: z.string().min(1),
  /** Absent in the first phase (nothing requested yet); then the export being polled. */
  reportId: z.number().int().optional(),
  /** Day (YYYY-MM-DD) up to which the export covers rows, carried to the apply step. */
  through: z.string().optional(),
  attempt: z.number().int().min(0),
});
type Payload = z.infer<typeof payload>;

export type T212ExportJobDeps = {
  db: Db;
  connectors: ConnectorDeps;
  /** Queues the next step of this job; `startAfter` is in seconds. */
  enqueue: (data: Payload, startAfter: number) => Promise<void>;
  /** Called with the household after rows were described (queues AI categorisation). */
  afterApply?: (householdId: string) => Promise<void>;
  now?: () => Date;
};

/**
 * Describes Trading 212 card payments from the history CSV export, in two phases over the same
 * queue. Phase 1 (no `reportId`) requests an export covering the oldest undescribed row and queues
 * a poll. Phase 2 polls it: `Finished` downloads, parses and applies it; `Queued`, `Processing`
 * and `Running` queue another poll (up to `T212_MAX_ATTEMPTS`); `Failed`, `Canceled` or a missing
 * export end the job. A 429 or an unreachable provider is retried later, never in a tight loop;
 * other provider errors end the job (the next sync starts over). Nothing sensitive is logged: no
 * CSV content, merchant names or amounts.
 */
export async function runT212ExportJob(deps: T212ExportJobDeps, data: unknown): Promise<void> {
  const parsed = payload.safeParse(data);
  if (!parsed.success) throw new Error('Invalid t212-export job payload');
  const job = parsed.data;
  const { householdId, connectionId } = job;
  const now = deps.now?.() ?? new Date();
  const tag = `t212-export ${connectionId}`;

  const retry = async (reason: string, delay = POLL_DELAY_SECONDS): Promise<void> => {
    if (job.attempt + 1 >= T212_MAX_ATTEMPTS) {
      log.warn(`${tag} gave up after ${T212_MAX_ATTEMPTS} attempts (${reason})`);
      return;
    }
    await deps.enqueue({ ...job, attempt: job.attempt + 1 }, Math.max(delay, POLL_DELAY_SECONDS));
  };

  try {
    const client = await openT212ExportClient(deps.db, deps.connectors, householdId, connectionId);
    if (!client) return;

    if (job.reportId === undefined) {
      const from = await findT212EnrichmentStart(deps.db, householdId, connectionId);
      if (from === null) return;
      const earliest = now.getTime() - MAX_RANGE_DAYS * DAY_MS;
      const timeFrom = new Date(Math.max(Date.parse(`${from}T00:00:00.000Z`), earliest));
      const reportId = await client.requestHistoryExport({
        timeFrom: timeFrom.toISOString(),
        timeTo: now.toISOString(),
      });
      // A card payment can reach the API days before the export describes it: only rows older
      // than SETTLE_DAYS count as covered, so recent ones are asked for again next time.
      const through = new Date(now.getTime() - SETTLE_DAYS * DAY_MS).toISOString().slice(0, 10);
      log.info(`${tag} requested export ${reportId}`);
      await deps.enqueue(
        { householdId, connectionId, reportId, through, attempt: 0 },
        POLL_DELAY_SECONDS,
      );
      return;
    }

    const found = (await client.listHistoryExports()).find((e) => e.reportId === job.reportId);
    if (!found) {
      log.warn(`${tag} export ${job.reportId} not found`);
      return;
    }
    if (found.status === 'Finished') {
      if (!found.downloadLink || job.through === undefined) {
        log.warn(`${tag} export ${job.reportId} finished without a usable download`);
        return;
      }
      const parsedCsv = parseTrading212ExportCsv(
        await client.downloadHistoryExport(found.downloadLink),
      );
      if (!parsedCsv.recognised) {
        // Only known column names are logged, never cell values. Not applying also leaves
        // `t212_enriched_through` alone, so the rows are tried again after the mapping is fixed.
        log.warn(
          `${tag} export ${job.reportId} columns not recognised, nothing applied: ${describeHeader(parsedCsv.header)}`,
        );
        return;
      }
      const { updated } = await applyT212Export(deps.db, {
        householdId,
        connectionId,
        rows: parsedCsv.rows,
        through: job.through,
      });
      log.info(`${tag} export ${job.reportId} applied (${updated} rows described)`);
      if (updated > 0) {
        // Failing to queue the AI pass must not fail the job: the sweep picks the rows up.
        await deps
          .afterApply?.(householdId)
          .catch((err: unknown) =>
            log.warn(`${tag} could not queue AI categorisation: ${errorMessage(err)}`),
          );
      }
      return;
    }
    if (['Queued', 'Processing', 'Running'].includes(found.status)) {
      await retry(`export ${found.status}`);
      return;
    }
    log.warn(`${tag} export ${job.reportId} ended as ${found.status}`);
  } catch (err) {
    if (err instanceof ProviderRateLimitError) {
      log.warn(`${tag} rate limited, retrying later`);
      await retry('rate limited', err.retryAfterSeconds);
    } else if (err instanceof ProviderUnavailableError) {
      log.warn(`${tag} provider unavailable, retrying later`);
      await retry('provider unavailable');
    } else if (err instanceof ProviderAuthError || err instanceof ProviderResponseError) {
      log.warn(`${tag} stopped: ${errorMessage(err)}`);
    } else throw err;
  }
}

/**
 * Registers the job. Returns the function the sync job calls after a successful sync: it queues
 * phase 1 for the connection (the job does nothing for a connection that is not Trading 212 or
 * has nothing to describe). The connection id is the singleton key, so a pending request or poll
 * is never doubled up; the queue's `short` policy lets the running job queue its own next step.
 */
export async function registerT212Export(
  boss: PgBoss,
  db: Db,
  getConnectors: () => Promise<ConnectorDeps>,
  afterApply?: (householdId: string) => Promise<void>,
): Promise<(householdId: string, connectionId: string) => Promise<void>> {
  const enqueue = async (data: Payload, startAfter: number): Promise<void> => {
    await boss.send(QUEUES.t212Export, data, {
      singletonKey: data.connectionId,
      startAfter,
      retryLimit: 0,
    });
  };
  await registerJob(
    boss,
    QUEUES.t212Export,
    async (job) =>
      runT212ExportJob(
        {
          db,
          connectors: await getConnectors(),
          enqueue,
          ...(afterApply ? { afterApply } : {}),
        },
        job.data,
      ),
    {},
    T212_EXPORT_QUEUE_OPTIONS,
  );
  return (householdId, connectionId) => enqueue({ householdId, connectionId, attempt: 0 }, 0);
}
