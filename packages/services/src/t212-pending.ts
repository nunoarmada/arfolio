import { sql, type SQL } from 'drizzle-orm';
import { schema } from '@arfolio/db';

const { connection, connectionAccount, transaction } = schema;

/** How long a card row is left for the Trading 212 export to name before the AI judges it blind. */
export const T212_EXPORT_GRACE_DAYS = 30;

/**
 * A Trading 212 card payment that the export has not described yet (the history API reports it
 * as `WITHDRAW <reference>` with no merchant) and that is recent enough for the export to still
 * do so. The AI passes skip these rows: a verdict on the bare reference would be a guess that
 * nothing revisits (see `applyT212Export`).
 */
export function awaitingT212Export(householdId: string): SQL {
  return sql`(${transaction.rawDescription} like 'WITHDRAW %'
    and ${transaction.counterparty} is null
    and ${transaction.bookingDate} >= current_date - ${T212_EXPORT_GRACE_DAYS}::int
    and exists (
      select 1 from ${connectionAccount}
      join ${connection} on ${connection.id} = ${connectionAccount.connectionId}
      where ${connectionAccount.accountId} = ${transaction.accountId}
        and ${connectionAccount.householdId} = ${householdId}
        and ${connection.provider} = 'trading212'))`;
}
