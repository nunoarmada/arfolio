import { and, eq, gt, inArray, isNull, like, lt, min, ne, or, sql } from 'drizzle-orm';
import type { Trading212ExportRow } from '@arfolio/connectors';
import { parseTransactionDetails } from '@arfolio/core';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import { readCredentials, type ConnectorDeps, type Trading212ExportPort } from './connections.js';
import { mergeDetailsSql } from './details-sql.js';
import { AI_MAX_ATTEMPTS } from './ai/categorise.js';
import { categorizeInTx } from './rules.js';

const { connection, connectionAccount, transaction } = schema;

const MAX_DESCRIPTION = 1_000;
const MAX_COUNTERPARTY = 300;
const ID_CHUNK = 1_000;

/** The connection's linked accounts and enrichment mark; null unless it is a Trading 212 one. */
async function linkedAccounts(tx: Tx, householdId: string, connectionId: string) {
  const [conn] = await tx
    .select({ provider: connection.provider, through: connection.t212EnrichedThrough })
    .from(connection)
    .where(and(eq(connection.id, connectionId), eq(connection.householdId, householdId)));
  if (conn?.provider !== 'trading212') return null;
  const links = await tx
    .select({ accountId: connectionAccount.accountId })
    .from(connectionAccount)
    .where(
      and(
        eq(connectionAccount.connectionId, connectionId),
        eq(connectionAccount.householdId, householdId),
      ),
    );
  return { accountIds: links.map((l) => l.accountId), through: conn.through };
}

/**
 * Booking date (YYYY-MM-DD) of the oldest row still to look up, or null when there is none.
 *
 * The Trading 212 history API reports a card payment as `WITHDRAW <reference>` with no merchant;
 * the CSV export has it. A row is still to be looked up while it keeps that description, has no
 * counterparty and was booked after the connection's `t212_enriched_through` day (the day up to
 * which an applied export already had the chance to describe it), so rows the export cannot
 * describe, such as bank withdrawals, are not requested again.
 */
export async function findT212EnrichmentStart(
  db: Db,
  householdId: string,
  connectionId: string,
): Promise<string | null> {
  return withHousehold(db, householdId, async (tx) => {
    const linked = await linkedAccounts(tx, householdId, connectionId);
    if (!linked || linked.accountIds.length === 0) return null;
    const [row] = await tx
      .select({ oldest: min(transaction.bookingDate) })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, householdId),
          inArray(transaction.accountId, linked.accountIds),
          like(transaction.externalId, 'tx:%'),
          like(transaction.rawDescription, 'WITHDRAW %'),
          isNull(transaction.counterparty),
          linked.through ? gt(transaction.bookingDate, linked.through) : undefined,
        ),
      );
    return row?.oldest ?? null;
  });
}

export type ApplyT212ExportInput = {
  householdId: string;
  connectionId: string;
  /** Parsed CSV rows by transaction reference (the part of `external_id` after `tx:`). */
  rows: Map<string, Trading212ExportRow>;
  /** Rows booked on or before this day (YYYY-MM-DD) have now had their chance to be described. */
  through: string;
};

/**
 * Writes the export's merchant onto the connection's rows that have no counterparty yet: merchant
 * name becomes counterparty and description; without one, a non-empty note becomes the description.
 * The export's merchant category is merged into `details`. Never overwrites a counterparty, so a repeat changes nothing. The changed rows are then
 * re-categorised (rules, then merchant memory; user choices and transfer legs are left alone);
 * an earlier AI category or verdict on them is dropped and their AI and merchant counters are
 * reset, so the next AI passes look again with the merchant name.
 * Finally `t212_enriched_through` moves forward (never back) to `through`.
 */
export async function applyT212Export(
  db: Db,
  input: ApplyT212ExportInput,
): Promise<{ updated: number }> {
  const { householdId, connectionId, rows, through } = input;
  return withHousehold(db, householdId, async (tx) => {
    const linked = await linkedAccounts(tx, householdId, connectionId);
    if (!linked) return { updated: 0 };
    const changed: string[] = [];
    const keys = linked.accountIds.length === 0 ? [] : [...rows.keys()].map((r) => `tx:${r}`);
    for (let i = 0; i < keys.length; i += ID_CHUNK) {
      const candidates = await tx
        .select({
          id: transaction.id,
          externalId: transaction.externalId,
          rawDescription: transaction.rawDescription,
        })
        .from(transaction)
        .where(
          and(
            eq(transaction.householdId, householdId),
            inArray(transaction.accountId, linked.accountIds),
            inArray(transaction.externalId, keys.slice(i, i + ID_CHUNK)),
            isNull(transaction.counterparty),
          ),
        );
      for (const row of candidates) {
        const info = rows.get(row.externalId!.slice('tx:'.length));
        if (!info) continue;
        const note = info.notes?.slice(0, MAX_DESCRIPTION);
        const category = parseTransactionDetails({ merchantCategory: info.merchantCategory });
        // Merged into whatever details the row already has (provider type, location, ...).
        const detailsSet = category
          ? { details: mergeDetailsSql(transaction.details, category) }
          : {};
        let set: { counterparty?: string; rawDescription: string };
        if (info.merchantName !== undefined) {
          set = {
            counterparty: info.merchantName.slice(0, MAX_COUNTERPARTY),
            rawDescription: info.merchantName.slice(0, MAX_DESCRIPTION),
          };
        } else if (note !== undefined && note !== row.rawDescription) {
          set = { rawDescription: note };
        } else {
          if (category) {
            await tx
              .update(transaction)
              .set(detailsSet)
              .where(and(eq(transaction.id, row.id), isNull(transaction.counterparty)));
          }
          continue;
        }
        await tx
          .update(transaction)
          .set({ ...set, ...detailsSet })
          .where(and(eq(transaction.id, row.id), isNull(transaction.counterparty)));
        changed.push(row.id);
      }
    }
    if (changed.length > 0) {
      for (let i = 0; i < changed.length; i += ID_CHUNK) {
        const scope = and(
          eq(transaction.householdId, householdId),
          inArray(transaction.id, changed.slice(i, i + ID_CHUNK)),
        );
        // A category the AI chose without the merchant name is dropped, so rules and memory (and
        // then the AI) judge the row again with it; user and rule choices stay.
        await tx
          .update(transaction)
          .set({
            categoryId: null,
            categorisedBy: null,
            confidence: null,
            needsReview: true,
            aiAttempts: 0,
          })
          .where(
            and(scope, eq(transaction.categorisedBy, 'ai'), isNull(transaction.transferGroupId)),
          );
      }
      await categorizeInTx(tx, householdId, changed);
      for (let i = 0; i < changed.length; i += ID_CHUNK) {
        const scope = and(
          eq(transaction.householdId, householdId),
          inArray(transaction.id, changed.slice(i, i + ID_CHUNK)),
        );
        // The AI and merchant passes may have looked at the bare reference: let them ask again.
        await tx
          .update(transaction)
          .set({ merchantEnrichedAt: null, merchantEnrichAttempts: 0 })
          .where(scope);
        await tx
          .update(transaction)
          .set({ aiSuggestedCategoryId: null, aiConfidence: null })
          .where(
            and(
              scope,
              isNull(transaction.categoryId),
              or(isNull(transaction.categorisedBy), ne(transaction.categorisedBy, 'user')),
            ),
          );
        // Rows whose attempts are capped (an AI category the user undid) stay capped.
        await tx
          .update(transaction)
          .set({ aiAttempts: 0 })
          .where(
            and(
              scope,
              isNull(transaction.categoryId),
              isNull(transaction.categorisedBy),
              lt(transaction.aiAttempts, AI_MAX_ATTEMPTS),
            ),
          );
      }
    }
    await tx
      .update(connection)
      .set({
        t212EnrichedThrough: sql`greatest(coalesce(${connection.t212EnrichedThrough}, ${through}::date), ${through}::date)`,
      })
      .where(and(eq(connection.id, connectionId), eq(connection.householdId, householdId)));
    return { updated: changed.length };
  });
}

/**
 * The export client of an active Trading 212 connection, or null when the connection is gone,
 * not Trading 212, not active, or the client cannot export.
 */
export async function openT212ExportClient(
  db: Db,
  deps: Pick<ConnectorDeps, 'encryptionKey' | 'trading212'>,
  householdId: string,
  connectionId: string,
): Promise<Trading212ExportPort | null> {
  const [row] = await withHousehold(db, householdId, (tx) =>
    tx
      .select({
        id: connection.id,
        provider: connection.provider,
        status: connection.status,
        credentialsEnc: connection.credentialsEnc,
      })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.householdId, householdId))),
  );
  if (row?.provider !== 'trading212' || row.status !== 'active') return null;
  const client = deps.trading212(readCredentials(deps, row));
  const { requestHistoryExport, listHistoryExports, downloadHistoryExport } = client;
  if (!requestHistoryExport || !listHistoryExports || !downloadHistoryExport) return null;
  return { requestHistoryExport, listHistoryExports, downloadHistoryExport };
}
