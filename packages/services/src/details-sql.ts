import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { TRANSACTION_DETAILS_MAX_BYTES, type TransactionDetails } from '@arfolio/core';

/**
 * `column || incoming` for the `details` jsonb (incoming keys win, other keys such as the
 * location survive). The merge is skipped, keeping the stored value, when the result would
 * exceed the size cap of a single details object: the extras are best-effort.
 */
export function mergeDetailsSql(column: AnyColumn, incoming: TransactionDetails): SQL {
  const merged = sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(incoming)}::jsonb`;
  return sql`case when octet_length((${merged})::text) <= ${TRANSACTION_DETAILS_MAX_BYTES}
    then ${merged} else ${column} end`;
}
