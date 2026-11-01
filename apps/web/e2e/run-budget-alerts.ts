/**
 * Runs the daily budget-alerts job body once for the household of the e2e database, the way the
 * worker does (the specs call it through tsx: the services are TypeScript source with ESM-style
 * import specifiers that only tsx resolves). `E2E_DATABASE_URL` is the database owner's URL.
 */
import { createDb } from '../../../packages/db/src/index.js';
import { runBudgetAlerts } from '../../../packages/services/src/index.js';

const url = process.env.E2E_DATABASE_URL;
if (!url) throw new Error('E2E_DATABASE_URL is not set');

const { db, pool } = createDb(url);
try {
  const { rows } = await pool.query<{ id: string }>('select id from organization limit 1');
  const householdId = rows[0]?.id;
  if (!householdId) throw new Error('no household in the e2e database');
  const result = await runBudgetAlerts({ db }, householdId);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
