import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import * as internal from '../src/internal.js';

// Transaction-level helpers take an open tx and skip role checks: they must not be public.
const INTERNAL = [
  'seedTemplatesInTx',
  'ingestRowsInTx',
  'lockAccountIngest',
  'createRuleInTx',
  'categorizeInTx',
  'requireUsableCategory',
  'ensureTransferCategory',
  'lockTransfers',
  'linkTransferLegs',
  'unlinkGroupInTx',
  'savePresetInTx',
  'listPresetsInTx',
  'queryTransactions',
  'transferCandidateFilter',
  'createNotificationInTx',
  'readCredentials',
  'createBudgetInTx',
  'upsertBudgetLineInTx',
  'setLineAmountsInTx',
  'linkCategoriesInTx',
  'budgetActualsQuery',
  'createAccountInTx',
  'createCategoryGroupInTx',
  'createCategoryInTx',
  'accountBalancesInTx',
  'netWorthInTx',
];

describe('public service API', () => {
  it.each(INTERNAL)('does not export %s from the package entry', (name) => {
    expect(Object.keys(api)).not.toContain(name);
  });

  it.each(INTERNAL)('keeps %s available to the package itself', (name) => {
    expect(typeof (internal as Record<string, unknown>)[name]).toBe('function');
  });

  it('exports no *InTx helper', () => {
    expect(Object.keys(api).filter((n) => n.endsWith('InTx'))).toEqual([]);
  });
});
