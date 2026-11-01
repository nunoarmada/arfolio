// Transaction-level helpers shared between service modules and the package's own tests. They take an
// open transaction and do no role check, so they are deliberately NOT re-exported from index.ts:
// callers outside this package go through the role-checked functions.
export { seedTemplatesInTx } from './category-templates.js';
export {
  INSERT_CHUNK,
  ID_CHUNK,
  chunks,
  keyRowsForDedupe,
  lockAccountIngest,
  ingestRowsInTx,
  expireVanishedPending,
} from './pipeline.js';
export {
  toCoreRule,
  requireUsableCategory,
  createRuleInTx,
  ruleDraftOf,
  categorizeInTx,
} from './rules.js';
export {
  queryTransactions,
  ensureTransferCategory,
  lockTransfers,
  linkTransferLegs,
  unlinkGroupInTx,
  transferCandidateFilter,
} from './transactions.js';
export { createAccountInTx } from './accounts.js';
export { createCategoryGroupInTx, createCategoryInTx } from './categories.js';
export { listPresetsInTx, savePresetInTx } from './import/presets.js';
export { nowOf, readCredentials, secretAad, syncLockKey, tryLock } from './connections.js';
export { consentExpiredKey, createNotificationInTx, isoDay } from './notifications.js';
export {
  createBudgetInTx,
  upsertBudgetLineInTx,
  setLineAmountsInTx,
  linkCategoriesInTx,
  budgetActualsQuery,
  savingFlowByMonthInTx,
} from './budgets.js';
export { accountBalancesInTx, netWorthInTx } from './net-worth.js';
export { createAssetInTx, updateAssetInTx, replaceImportedValuationsInTx } from './assets.js';
export {
  createLiabilityInTx,
  updateLiabilityInTx,
  replaceImportedBalancesInTx,
} from './liabilities.js';
export { createGoalInTx, updateGoalInTx } from './goals.js';
