import { and, asc, eq, getTableColumns, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { normalizeDescription, type BudgetKind } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertUuid,
  ConflictError,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from '../../context.js';
import { createAccountInTx } from '../../accounts.js';
import {
  claimedAccounts,
  createAssetInTx,
  replaceImportedValuationsInTx,
  updateAssetInTx,
} from '../../assets.js';
import {
  createGoalInTx,
  currentSavedInTx,
  rolledBaselineInTx,
  updateGoalInTx,
  type Goal,
  type YearViewCache,
} from '../../goals.js';
import { refreshStoredSnapshotsInTx } from '../../net-worth.js';
import {
  createLiabilityInTx,
  replaceImportedBalancesInTx,
  updateLiabilityInTx,
} from '../../liabilities.js';
import {
  createBudgetInTx,
  linkCategoriesInTx,
  setLineAmountsInTx,
  upsertBudgetLineInTx,
} from '../../budgets.js';
import { resolveTemplateLocale, type TemplateLocale } from '../../category-templates.js';
import { createCategoryGroupInTx, createCategoryInTx } from '../../categories.js';
import { localDay } from '../../sync.js';
import { MAX_IMPORT_BYTES } from '../types.js';
import {
  parseBudgetWorkbook,
  type BudgetImportWarning,
  type ParsedBudgetLine,
  type ParsedBudgetSheet,
  type ParsedGoal,
  type ParsedNetWorthRow,
  type ParsedSubscription,
} from './parse.js';
import { normalizeName, readBudgetWorkbook, unreadableFile } from './read.js';

const {
  asset,
  budget,
  budgetLine,
  goal,
  liability,
  category,
  categoryGroup,
  financialAccount,
  householdSettings,
  recurring,
  undoToken,
} = schema;

/** How long a preview can be committed. */
const PREVIEW_TTL_MS = 30 * 60_000;
const KINDS = ['income', 'expense', 'saving'] as const;
/** Names of the groups created when the household has no suitable one, per kind. */
const DEFAULT_GROUP_NAME = {
  income: {
    'pt-PT': 'Receitas',
    'es-ES': 'Ingresos',
    'fr-FR': 'Revenus',
    'it-IT': 'Entrate',
    en: 'Income',
  },
  saving: {
    'pt-PT': 'Poupança',
    'es-ES': 'Ahorro',
    'fr-FR': 'Épargne',
    'it-IT': 'Risparmio',
    en: 'Savings',
  },
} as const;
const OTHER_GROUP_NAME = {
  'pt-PT': 'Outros',
  'es-ES': 'Otros',
  'fr-FR': 'Autres',
  'it-IT': 'Altro',
  en: 'Other',
} as const;
/** The word for "budget" in each template locale, used to name the imported budget. */
const BUDGET_WORD = {
  'pt-PT': 'Orçamento',
  'es-ES': 'Presupuesto',
  'fr-FR': 'Budget',
  'it-IT': 'Budget',
  en: 'Budget',
} as const;
/** Template keys of the seeded income and saving groups: the household's default ones. */
const DEFAULT_GROUP_TEMPLATE = { income: 'income', saving: 'savings' } as const;

// ---------------------------------------------------------------------------------------------
// Types and schemas

const fileSchema = z.strictObject({
  fileName: z.string().min(1).max(1_000),
  bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'expected the file bytes'),
});
const choicesSchema = z.strictObject({
  createMissingAccounts: z.boolean(),
  createMissingGroups: z.boolean(),
  replaceExisting: z.boolean(),
  /** Património and Objetivos: imported when the sheet is present, unless switched off. */
  includePatrimonio: z.boolean().optional(),
  includeObjetivos: z.boolean().optional(),
  /**
   * Per Património row (key `asset:<name>` or `liability:<name>`, the name normalised with
   * normalizeName): the account to link it to, or null for none. Rows not listed take the
   * suggestion (the account of the same normalised name, if any).
   */
  accountLinks: z.record(z.string(), z.string().nullable()).optional(),
});

type StoredSheet = z.output<typeof storedSchema>['sheet'];

export type BudgetImportFile = z.input<typeof fileSchema>;
export type BudgetImportChoices = z.input<typeof choicesSchema>;

/** What the server keeps for a token: the parsed sheet, so a caller cannot commit data it chose. */
const lineSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string().min(1),
  group: z.string().min(1).nullable(),
  account: z.string().min(1).nullable(),
  amounts: z.array(z.number().int().safe()).length(12),
});
const subscriptionSchema = z.object({
  name: z.string().min(1),
  amount: z.number().int().safe(),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  account: z.string().min(1).nullable(),
});
const netWorthRowSchema = z.object({
  name: z.string().min(1),
  tipo: z.string(),
  kind: z.string().min(1),
  notes: z.string().min(1).nullable(),
  values: z.array(z.object({ asOf: z.string(), amount: z.number().int().safe().min(0) })),
});
const goalSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['generic', 'emergency_fund']),
  target: z.number().int().safe().min(0).nullable(),
  contribution: z.number().int().safe().min(0).nullable(),
  saved: z.number().int().safe(),
});
const storedSchema = z.object({
  fileName: z.string(),
  sheet: z.object({
    startMonth: z.string().regex(/^\d{4}-\d{2}-01$/),
    emergencyFundMonths: z.number().int().min(0).nullable(),
    accounts: z.array(z.string().min(1)),
    groups: z.array(z.string().min(1)),
    lines: z.array(lineSchema),
    subscriptions: z.array(subscriptionSchema),
    subscriptionsSkipped: z.number().int().min(0),
    // Absent from previews made before Património and Objetivos were read.
    patrimonio: z
      .object({
        assets: z.array(netWorthRowSchema.extend({ kind: z.enum(schema.ASSET_KINDS) })),
        liabilities: z.array(netWorthRowSchema.extend({ kind: z.enum(schema.LIABILITY_KINDS) })),
      })
      .nullable()
      .default(null),
    goals: z.array(goalSchema).nullable().default(null),
    warnings: z.array(
      z.object({
        code: z.enum([
          'total_mismatch',
          'month_header_mismatch',
          'unknown_periodicity',
          'empty_section',
          'duplicate_line_name',
          'zero_value_subscription',
          'unknown_net_worth_type',
          'derived_target',
          'saved_ignored',
          'saved_differs',
          'currency_mismatch',
        ]),
        params: z.record(z.string(), z.union([z.string(), z.number()])),
      }),
    ),
  }),
});

/** A Património row as previewed. */
export type BudgetImportNetWorthRow<K extends string> = ParsedNetWorthRow<K> & {
  /** The key of this row in `accountLinks` (side and normalised name): never rebuilt by callers. */
  linkKey: string;
  /**
   * The household account whose normalised name equals the row's: the proposed link. Null when
   * a live record other than the row's match already counts that account.
   */
  suggestedAccountId: string | null;
  /** The existing asset or liability committing would update instead of creating. */
  match: string | null;
  /** The account that matched record is linked to now (null: none, or no match). */
  currentAccountId: string | null;
};

export type BudgetImportPreview = {
  /** Opaque, single-use, valid for 30 minutes: pass it to commitBudgetImport. */
  token: string;
  /** ISO timestamp the token stops working. */
  expiresAt: string;
  fileName: string;
  /** `yyyy-mm-01`. */
  startMonth: string;
  /** The name the budget gets (a replaced budget keeps its own). */
  budgetName: string;
  /** A budget of the household already starts that month: committing needs `replaceExisting`. */
  existingBudgetId: string | null;
  emergencyFundMonths: number | null;
  /** `match` is the id of the household account of that name, if any (preview only). */
  accounts: Array<{ name: string; match: string | null }>;
  groups: Array<{ name: string; kind: BudgetKind; match: string | null }>;
  lines: ParsedBudgetLine[];
  subscriptions: ParsedSubscription[];
  /** Inactive subscriptions left out. */
  subscriptionsSkipped: number;
  /** `null` when the workbook has no Património sheet. */
  patrimonio: {
    assets: Array<BudgetImportNetWorthRow<schema.AssetKind>>;
    liabilities: Array<BudgetImportNetWorthRow<schema.LiabilityKind>>;
  } | null;
  /** `null` when the workbook has no Objetivos sheet. `match` is the goal committing would update. */
  goals: Array<
    ParsedGoal & {
      match: string | null;
      /** The sheet has a saving line with the goal's name: committing links the goal to it. */
      lineMatch: boolean;
    }
  > | null;
  warnings: BudgetImportWarning[];
};

export type BudgetImportResult = {
  budgetId: string;
  /** True when an existing budget's lines were replaced; false when the budget was created. */
  replaced: boolean;
  accountsCreated: number;
  groupsCreated: number;
  categoriesCreated: number;
  linesImported: number;
  subscriptionsImported: number;
  subscriptionsSkipped: number;
  assetsCreated: number;
  assetsUpdated: number;
  liabilitiesCreated: number;
  liabilitiesUpdated: number;
  goalsCreated: number;
  goalsUpdated: number;
  /** Stored net worth months recomputed because imported values reach them (gaps stay gaps). */
  snapshotsRefreshed: number;
  /** Findings of the commit itself (`currency_mismatch`); the preview's stay in its own list. */
  warnings: BudgetImportWarning[];
};

// ---------------------------------------------------------------------------------------------
// Names and matching

/** First spelling wins; compared with normalizeName. */
function uniqueNames<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every account name the sheet mentions: the Config list, then those used by lines and subscriptions. */
function sheetAccounts(sheet: ParsedBudgetSheet): string[] {
  const used = [...sheet.lines, ...sheet.subscriptions].flatMap((r) =>
    r.account ? [r.account] : [],
  );
  return uniqueNames([...sheet.accounts, ...used], normalizeName);
}

/** Every group the sheet names: Config's expense groups, then the group of each line (by kind). */
function sheetGroups(sheet: ParsedBudgetSheet): Array<{ name: string; kind: BudgetKind }> {
  const configured = sheet.groups.map((name) => ({ name, kind: 'expense' as BudgetKind }));
  const used = sheet.lines.flatMap((l) => (l.group ? [{ name: l.group, kind: l.kind }] : []));
  return uniqueNames([...configured, ...used], (g) => `${g.kind}:${normalizeName(g.name)}`);
}

type GroupRow = { id: string; name: string; templateKey: string | null };

/** The household's matchable accounts, groups (by kind) and categories, as of this transaction. */
async function loadCatalog(tx: Tx, householdId: string) {
  const accounts = await tx
    .select({ id: financialAccount.id, name: financialAccount.name })
    .from(financialAccount)
    .where(and(eq(financialAccount.householdId, householdId), isNull(financialAccount.archivedAt)))
    .orderBy(asc(financialAccount.sort), asc(financialAccount.name), asc(financialAccount.id));
  const groups = await tx
    .select({
      id: categoryGroup.id,
      name: categoryGroup.name,
      kind: categoryGroup.kind,
      templateKey: categoryGroup.templateKey,
    })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.householdId, householdId), isNull(categoryGroup.archivedAt)))
    .orderBy(asc(categoryGroup.sort), asc(categoryGroup.name), asc(categoryGroup.id));
  const accountByName = new Map<string, string>();
  for (const a of accounts) {
    if (!accountByName.has(normalizeName(a.name))) accountByName.set(normalizeName(a.name), a.id);
  }
  const groupsByKind: Record<BudgetKind, GroupRow[]> = { income: [], expense: [], saving: [] };
  for (const g of groups) {
    if (g.kind !== 'transfer') groupsByKind[g.kind].push(g);
  }
  return {
    accountByName,
    groupsByKind,
    matchGroup: (kind: BudgetKind, name: string) =>
      groupsByKind[kind].find((g) => normalizeName(g.name) === normalizeName(name))?.id ?? null,
  };
}

async function loadSettings(tx: Tx, householdId: string) {
  const [settings] = await tx
    .select({
      locale: householdSettings.locale,
      currency: householdSettings.currency,
      timezone: householdSettings.timezone,
    })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  return {
    locale: resolveTemplateLocale(settings?.locale ?? 'en'),
    currency: settings?.currency ?? 'EUR',
    timezone: settings?.timezone ?? 'UTC',
  };
}

/** "Orçamento 2026/27" (or "Orçamento 2027" from January), with the word for budget in the locale. */
function budgetNameOf(startMonth: string, locale: TemplateLocale): string {
  const year = Number(startMonth.slice(0, 4));
  // A calendar-year budget is named by its year; otherwise by the two years it spans.
  const span =
    startMonth.slice(5, 7) === '01'
      ? String(year)
      : `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
  return `${BUDGET_WORD[locale]} ${span}`;
}

async function findBudgetAt(tx: Tx, householdId: string, startMonth: string) {
  const [existing] = await tx
    .select({ id: budget.id })
    .from(budget)
    .where(and(eq(budget.householdId, householdId), eq(budget.startMonth, startMonth)));
  return existing?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Património and Objetivos

/**
 * How a sheet goal is matched to an existing one: by kind and normalised name, except the emergency
 * fund, of which a household has one, so any name matches it.
 */
const goalKey = (kind: string, name: string): string =>
  kind === 'emergency_fund' ? kind : `${kind}:${normalizeName(name)}`;

/** The household's active assets, liabilities and goals by normalised name (first one wins). */
async function loadNetWorthCatalog(tx: Tx, householdId: string) {
  const first = <T extends { name: string }>(rows: T[], key: (r: T) => string) => {
    const map = new Map<string, T>();
    for (const r of rows) if (!map.has(key(r))) map.set(key(r), r);
    return map;
  };
  const assets = await tx
    .select({
      id: asset.id,
      name: asset.name,
      accountId: asset.accountId,
      currency: asset.currency,
      position: asset.position,
    })
    .from(asset)
    .where(
      and(eq(asset.householdId, householdId), eq(asset.archived, false), isNull(asset.disposedOn)),
    )
    .orderBy(asc(asset.position), asc(asset.name), asc(asset.id));
  const liabilities = await tx
    .select({
      id: liability.id,
      name: liability.name,
      accountId: liability.accountId,
      currency: liability.currency,
      position: liability.position,
    })
    .from(liability)
    .where(
      and(
        eq(liability.householdId, householdId),
        eq(liability.archived, false),
        isNull(liability.settledOn),
      ),
    )
    .orderBy(asc(liability.position), asc(liability.name), asc(liability.id));
  const goals = await tx
    .select()
    .from(goal)
    .where(and(eq(goal.householdId, householdId), eq(goal.archived, false)))
    .orderBy(asc(goal.position), asc(goal.name), asc(goal.id));
  /** New records go after the user's order. */
  const after = (rows: Array<{ position: number }>) =>
    rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
  return {
    assets: first(assets, (r) => normalizeName(r.name)),
    liabilities: first(liabilities, (r) => normalizeName(r.name)),
    goals: first(goals, (r) => goalKey(r.kind, r.name)),
    nextPosition: { assets: after(assets), liabilities: after(liabilities), goals: after(goals) },
  };
}

/** A budget line by kind and normalised name: how a goal finds its line again after a re-import. */
const lineKey = (kind: string, name: string) => `${kind}:${normalizeName(name)}`;

/** Every goal (archived ones included) linked to a line of `budgetId`, with that line's key. */
async function goalsOnBudget(tx: Tx, householdId: string, budgetId: string) {
  const rows = await tx
    .select({ goal: getTableColumns(goal), lineKind: budgetLine.kind, lineName: budgetLine.name })
    .from(goal)
    .innerJoin(
      budgetLine,
      and(eq(budgetLine.id, goal.budgetLineId), eq(budgetLine.householdId, goal.householdId)),
    )
    .where(and(eq(goal.householdId, householdId), eq(budgetLine.budgetId, budgetId)))
    .orderBy(asc(goal.position), asc(goal.name), asc(goal.id));
  return rows.map((r) => ({ ...r.goal, lineKey: lineKey(r.lineKind, r.lineName) }));
}

/**
 * What Saldo atual does to a goal. It is ignored for a goal linked to an account (its balance is
 * what is saved) and when negative, and reported as `saved_ignored`. A zero changes nothing.
 * A positive one becomes the baseline, dated the import date, of a new goal and of a matched goal
 * that has no baseline, no budget line and no account. A matched goal otherwise keeps its stored
 * baseline and date, which carry the progress the app tracked since the last import; when the
 * sheet's figure differs from what the app has saved, that is reported as `saved_differs`.
 */
async function planSaved(
  tx: Tx,
  householdId: string,
  g: ParsedGoal,
  found: Goal | undefined,
  now: Date,
  views: YearViewCache,
): Promise<{ warning: BudgetImportWarning | null; writeBaseline: boolean }> {
  if (g.saved === 0) return { warning: null, writeBaseline: false };
  if (g.saved < 0 || found?.accountId != null) {
    return {
      warning: { code: 'saved_ignored', params: { name: g.name, amount: g.saved } },
      writeBaseline: false,
    };
  }
  if (!found) return { warning: null, writeBaseline: true };
  if (found.savedBaseline === null && !found.budgetLineId) {
    return { warning: null, writeBaseline: true };
  }
  const app = await currentSavedInTx(tx, householdId, found, now, views);
  return {
    warning:
      app === g.saved
        ? null
        : { code: 'saved_differs', params: { name: g.name, sheet: g.saved, app } },
    writeBaseline: false,
  };
}

/** The key of a Património row in `accountLinks`. */
const linkKey = (side: 'asset' | 'liability', name: string) => `${side}:${normalizeName(name)}`;

/**
 * Writes the Património and Objetivos sections. Assets, liabilities and goals are matched to the
 * household's active ones by normalised name (and side, and kind for goals; the one emergency
 * fund matches whatever its name) and updated, so importing again never duplicates. Only valuations and balances that an earlier import wrote
 * (`method`/`source` `import`) are replaced, and only on the same dates; manual, connector,
 * depreciation and schedule rows are never touched. Months that have not ended by `today` are
 * dropped again here (the preview may be older than the commit). A row linked to an account (the
 * account is the source of truth) gets no valuations or balances, and neither does a matched
 * record in another currency than the household's (`currency_mismatch`): its values would be
 * summed as if they were in the household currency.
 *
 * A matched record keeps its position (the user's order; new records are appended), takes its
 * kind from the sheet, and keeps its notes when the sheet's Notas cell is blank. Its account link
 * follows `links`: a key present (null included) sets or clears the link, an absent key leaves it
 * as it is, and only a new row takes the suggestion. Goals are different: the sheet is their
 * source, so a blank target or contribution clears the stored value.
 *
 * Returns the earliest date a value was written for: the caller recomputes the stored net worth
 * months from there (refreshStoredSnapshotsInTx).
 *
 * There is deliberately no undo for this section: records an import only updated keep the new
 * values, and importing the corrected workbook again is the way back.
 */
async function importNetWorth(
  tx: Tx,
  householdId: string,
  sheet: StoredSheet,
  include: { patrimonio: boolean; objetivos: boolean },
  accounts: { links: Record<string, string | null>; suggestions: ReadonlyMap<string, string> },
  savingLineId: ReadonlyMap<string, string>,
  currency: string,
  clock: { now: Date; today: string },
) {
  const { today } = clock;
  const counts = {
    assetsCreated: 0,
    assetsUpdated: 0,
    liabilitiesCreated: 0,
    liabilitiesUpdated: 0,
    goalsCreated: 0,
    goalsUpdated: 0,
  };
  const warnings: BudgetImportWarning[] = [];
  /** The earliest date a valuation or balance was written for: stored months from there change. */
  let earliestValue: string | null = null;
  const wrote = (dates: Array<{ asOf: string }>) => {
    for (const { asOf } of dates) {
      if (earliestValue === null || asOf < earliestValue) earliestValue = asOf;
    }
  };
  const existing = await loadNetWorthCatalog(tx, householdId);
  const next = { ...existing.nextPosition };
  // Accounts a live record already counts are never suggested (a second link would be refused).
  const claimed = await claimedAccounts(tx, householdId);
  /** The link to write: undefined leaves it alone, null clears it. */
  const linkFor = (
    side: 'asset' | 'liability',
    name: string,
    found: object | undefined,
  ): string | null | undefined => {
    const key = linkKey(side, name);
    if (key in accounts.links) return accounts.links[key];
    if (found) return undefined;
    const suggested = accounts.suggestions.get(normalizeName(name));
    return suggested && !claimed.has(suggested) ? suggested : null;
  };
  const ended = <T extends { asOf: string }>(values: T[]) => values.filter((v) => v.asOf <= today);

  if (include.patrimonio && sheet.patrimonio) {
    for (const row of sheet.patrimonio.assets) {
      const found = existing.assets.get(normalizeName(row.name));
      const accountId = linkFor('asset', row.name, found);
      const notes = row.notes !== null ? { notes: row.notes } : {};
      let saved;
      if (found) {
        saved = await updateAssetInTx(tx, householdId, found.id, {
          kind: row.kind,
          ...notes,
          ...(accountId !== undefined ? { accountId } : {}),
        });
        counts.assetsUpdated += 1;
      } else {
        saved = await createAssetInTx(tx, householdId, {
          kind: row.kind,
          name: row.name,
          ...notes,
          accountId: accountId ?? null,
          position: next.assets++,
        });
        counts.assetsCreated += 1;
      }
      if (saved.accountId) claimed.set(saved.accountId, saved.id);
      if (saved.currency !== currency) {
        warnings.push({ code: 'currency_mismatch', params: { name: row.name } });
      } else if (!saved.accountId) {
        const values = ended(row.values).map((v) => ({ asOf: v.asOf, value: v.amount }));
        await replaceImportedValuationsInTx(tx, householdId, saved.id, values);
        wrote(values);
      }
    }
    for (const row of sheet.patrimonio.liabilities) {
      const found = existing.liabilities.get(normalizeName(row.name));
      const accountId = linkFor('liability', row.name, found);
      const notes = row.notes !== null ? { notes: row.notes } : {};
      let saved;
      if (found) {
        saved = await updateLiabilityInTx(tx, householdId, found.id, {
          kind: row.kind,
          ...notes,
          ...(accountId !== undefined ? { accountId } : {}),
        });
        counts.liabilitiesUpdated += 1;
      } else {
        saved = await createLiabilityInTx(tx, householdId, {
          kind: row.kind,
          name: row.name,
          ...notes,
          accountId: accountId ?? null,
          position: next.liabilities++,
        });
        counts.liabilitiesCreated += 1;
      }
      if (saved.accountId) claimed.set(saved.accountId, saved.id);
      if (saved.currency !== currency) {
        warnings.push({ code: 'currency_mismatch', params: { name: row.name } });
      } else if (!saved.accountId) {
        const balances = ended(row.values).map((v) => ({ asOf: v.asOf, balance: v.amount }));
        await replaceImportedBalancesInTx(tx, householdId, saved.id, balances);
        wrote(balances);
      }
    }
  }

  if (include.objetivos && sheet.goals) {
    const views: YearViewCache = new Map();
    for (const g of sheet.goals) {
      const lineId = savingLineId.get(normalizeName(g.name));
      const found = existing.goals.get(goalKey(g.kind, g.name));
      const fields: Parameters<typeof updateGoalInTx>[3] = {
        targetAmount: g.target,
        monthlyContribution: g.contribution,
        ...(lineId ? { budgetLineId: lineId } : {}),
      };
      const plan = await planSaved(tx, householdId, g, found, clock.now, views);
      if (plan.warning) warnings.push(plan.warning);
      if (plan.writeBaseline) {
        Object.assign(fields, { savedBaseline: g.saved, savedBaselineDate: today });
      }
      if (found) {
        await updateGoalInTx(tx, householdId, found.id, fields, { now: clock.now });
        counts.goalsUpdated += 1;
      } else {
        await createGoalInTx(
          tx,
          householdId,
          { ...fields, kind: g.kind, name: g.name, position: next.goals++ },
          { now: clock.now },
        );
        counts.goalsCreated += 1;
      }
    }
  }
  return { counts, warnings, earliestValue: earliestValue as string | null };
}

// ---------------------------------------------------------------------------------------------
// Preview

/**
 * Reads a budget workbook and shows what importing it would do, without changing any budget data.
 * The parsed sheet is kept server-side under an opaque token (one use, 30 minutes, this user),
 * which commitBudgetImport needs; the file itself is untrusted and read through the hardened XLSX
 * reader. The result is plain JSON. Writers only.
 */
export async function previewBudgetImport(
  ctx: ServiceCtx,
  rawFile: BudgetImportFile,
  opts: { now?: Date } = {},
): Promise<BudgetImportPreview> {
  assertCanWrite(ctx);
  const file = parseInput(fileSchema, rawFile);
  if (!file.fileName.toLowerCase().endsWith('.xlsx')) {
    throw unreadableFile('Unsupported file type: use an XLSX workbook');
  }
  if (file.bytes.length > MAX_IMPORT_BYTES) {
    throw unreadableFile('The file is too large (maximum 10 MB)');
  }
  const workbook = await readBudgetWorkbook(Buffer.from(file.bytes));
  // Património months that have not ended in the household's calendar are projections.
  const { timezone } = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    loadSettings(tx, ctx.householdId),
  );
  const sheet = parseBudgetWorkbook(workbook, {
    today: localDay(opts.now ?? new Date(), timezone),
  });
  const fileName = file.fileName.slice(0, 255);

  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await tx.delete(undoToken).where(lt(undoToken.expiresAt, sql`now()`));
    const settings = await loadSettings(tx, ctx.householdId);
    const catalog = await loadCatalog(tx, ctx.householdId);
    const existingBudgetId = await findBudgetAt(tx, ctx.householdId, sheet.startMonth);
    const existing = await loadNetWorthCatalog(tx, ctx.householdId);
    const claimed = await claimedAccounts(tx, ctx.householdId);
    /** The same-name account, unless a record other than the row's own match counts it. */
    const suggestionFor = (name: string, match: string | null) => {
      const id = catalog.accountByName.get(normalizeName(name));
      return id && (claimed.get(id) ?? match) === match ? id : null;
    };
    const withLinks = <K extends string>(
      side: 'asset' | 'liability',
      row: ParsedNetWorthRow<K>,
      matches: Map<string, { id: string; accountId: string | null }>,
    ) => ({
      ...row,
      linkKey: linkKey(side, row.name),
      suggestedAccountId: suggestionFor(row.name, matches.get(normalizeName(row.name))?.id ?? null),
      match: matches.get(normalizeName(row.name))?.id ?? null,
      currentAccountId: matches.get(normalizeName(row.name))?.accountId ?? null,
    });
    const savingNames = new Set(
      sheet.lines.filter((l) => l.kind === 'saving').map((l) => normalizeName(l.name)),
    );
    const warnings = [...sheet.warnings];
    if (existingBudgetId) {
      // Replacing the budget's lines unlinks a goal whose line the sheet no longer has, unless
      // the sheet's Objetivos links it again.
      const lineKeys = new Set(sheet.lines.map((l) => lineKey(l.kind, l.name)));
      const relinked = new Set(
        (sheet.goals ?? []).flatMap((g) => {
          const found = existing.goals.get(goalKey(g.kind, g.name));
          return found && savingNames.has(normalizeName(g.name)) ? [found.id] : [];
        }),
      );
      for (const g of await goalsOnBudget(tx, ctx.householdId, existingBudgetId)) {
        if (!g.archived && !lineKeys.has(g.lineKey) && !relinked.has(g.id)) {
          warnings.push({ code: 'goal_unlinked', params: { name: g.name } });
        }
      }
    }
    const views: YearViewCache = new Map();
    for (const g of sheet.goals ?? []) {
      const found = existing.goals.get(goalKey(g.kind, g.name));
      const plan = await planSaved(tx, ctx.householdId, g, found, opts.now ?? new Date(), views);
      if (plan.warning) warnings.push(plan.warning);
    }
    for (const [rows, matches] of [
      [sheet.patrimonio?.assets ?? [], existing.assets],
      [sheet.patrimonio?.liabilities ?? [], existing.liabilities],
    ] as const) {
      for (const row of rows) {
        const found = matches.get(normalizeName(row.name));
        if (found && found.currency !== settings.currency) {
          warnings.push({ code: 'currency_mismatch', params: { name: row.name } });
        }
      }
    }
    const [stored] = await tx
      .insert(undoToken)
      .values({
        householdId: ctx.householdId,
        userId: ctx.userId,
        kind: 'budget_import',
        payload: { fileName, sheet },
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
      })
      .returning({ id: undoToken.id, expiresAt: undoToken.expiresAt });
    return {
      token: stored!.id,
      expiresAt: stored!.expiresAt.toISOString(),
      fileName,
      startMonth: sheet.startMonth,
      budgetName: budgetNameOf(sheet.startMonth, settings.locale),
      existingBudgetId,
      emergencyFundMonths: sheet.emergencyFundMonths,
      accounts: sheetAccounts(sheet).map((name) => ({
        name,
        match: catalog.accountByName.get(normalizeName(name)) ?? null,
      })),
      groups: sheetGroups(sheet).map((g) => ({ ...g, match: catalog.matchGroup(g.kind, g.name) })),
      lines: sheet.lines,
      subscriptions: sheet.subscriptions,
      subscriptionsSkipped: sheet.subscriptionsSkipped,
      patrimonio: sheet.patrimonio
        ? {
            assets: sheet.patrimonio.assets.map((r) => withLinks('asset', r, existing.assets)),
            liabilities: sheet.patrimonio.liabilities.map((r) =>
              withLinks('liability', r, existing.liabilities),
            ),
          }
        : null,
      goals:
        sheet.goals?.map((g) => ({
          ...g,
          match: existing.goals.get(goalKey(g.kind, g.name))?.id ?? null,
          lineMatch: savingNames.has(normalizeName(g.name)),
        })) ?? null,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Commit

/**
 * Imports the previewed budget in one transaction: matches or creates the accounts and groups
 * (as `choices` allow), one category per line (reusing a same-named one in the group, else the
 * only same-named non-archived category of the line's kind anywhere in the household), the
 * budget with its lines, amounts and category links, the active subscriptions as `recurring`
 * rows (`source = 'import'`) and the emergency fund months. When a budget already starts that
 * month it is a ConflictError `budget_exists` unless `replaceExisting`, which replaces that
 * budget's lines (goals on them follow the recreated line of the same name, see goal_unlinked).
 * Stored net worth months reached by imported values are recomputed. Transactions are never touched. Anything failing rolls everything back and
 * leaves the token usable. Names are matched again here, against the current data. Writers only.
 */
export async function commitBudgetImport(
  ctx: ServiceCtx,
  token: string,
  rawChoices: BudgetImportChoices,
  opts: { now?: Date } = {},
): Promise<BudgetImportResult> {
  assertCanWrite(ctx);
  assertUuid(token, 'Preview token');
  const choices = parseInput(choicesSchema, rawChoices);
  // Expired tokens go in their own transaction, so the delete survives a refusal below. The
  // caller's own token stays until it is read, so that its expiry can be told from "unknown".
  await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx.delete(undoToken).where(and(lt(undoToken.expiresAt, sql`now()`), ne(undoToken.id, token))),
  );

  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`budget-import:${ctx.householdId}`}, 0))`,
    );
    const [held] = await tx
      .select()
      .from(undoToken)
      .where(and(eq(undoToken.id, token), eq(undoToken.householdId, ctx.householdId)))
      .for('update');
    if (!held || held.userId !== ctx.userId || held.kind !== 'budget_import') {
      throw new NotFoundError('Preview token');
    }
    if (held.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('This preview has expired', [], 'preview_expired');
    }
    if (held.usedAt) throw new ValidationError('This preview was already used', [], 'preview_used');
    const { sheet } = parseInput(storedSchema, held.payload);

    const existingBudgetId = await findBudgetAt(tx, ctx.householdId, sheet.startMonth);
    if (existingBudgetId && !choices.replaceExisting) {
      throw new ConflictError('budget_exists', 'A budget already exists for this start month');
    }
    const settings = await loadSettings(tx, ctx.householdId);
    const catalog = await loadCatalog(tx, ctx.householdId);
    // Suggested links come from the accounts that exist now, as in the preview, not from those
    // this commit creates for the budget.
    const existingAccounts = new Map(catalog.accountByName);
    const include = {
      patrimonio: choices.includePatrimonio ?? true,
      objetivos: choices.includeObjetivos ?? true,
    };
    const links = choices.accountLinks ?? {};
    const linkable = new Set([
      ...(sheet.patrimonio?.assets ?? []).map((r) => linkKey('asset', r.name)),
      ...(sheet.patrimonio?.liabilities ?? []).map((r) => linkKey('liability', r.name)),
    ]);
    const unknown = Object.keys(links).find((key) => !linkable.has(key));
    if (unknown !== undefined) {
      throw new ValidationError(`No Património row matches the link "${unknown}"`, [
        { path: ['accountLinks', unknown], message: 'no such row' },
      ]);
    }
    let accountsCreated = 0;
    let groupsCreated = 0;
    let categoriesCreated = 0;

    // Accounts: matched by name, else created (type other) when allowed, else the lines get none.
    const accountId = new Map<string, string | null>();
    for (const name of sheetAccounts(sheet)) {
      let id = catalog.accountByName.get(normalizeName(name)) ?? null;
      if (!id && choices.createMissingAccounts) {
        id = (await createAccountInTx(tx, ctx.householdId, { name, type: 'other' })).id;
        catalog.accountByName.set(normalizeName(name), id);
        accountsCreated += 1;
      }
      accountId.set(normalizeName(name), id);
    }
    const accountOf = (name: string | null) =>
      name ? (accountId.get(normalizeName(name)) ?? null) : null;

    // Groups named by the sheet: matched within their kind, else created when allowed.
    const namedGroup = new Map<string, string | null>();
    const groupKey = (kind: BudgetKind, name: string) => `${kind}:${normalizeName(name)}`;
    for (const { name, kind } of sheetGroups(sheet)) {
      let id = catalog.matchGroup(kind, name);
      if (!id && choices.createMissingGroups) {
        const created = await createCategoryGroupInTx(tx, ctx.householdId, { name, kind });
        catalog.groupsByKind[kind].push(created);
        id = created.id;
        groupsCreated += 1;
      }
      namedGroup.set(groupKey(kind, name), id);
    }

    // Fallback groups, created on first need: "Outros"/"Other" for expenses, the household's
    // income or saving group for those kinds.
    const fallback = new Map<BudgetKind, string>();
    const fallbackGroup = async (kind: BudgetKind): Promise<string> => {
      const known = fallback.get(kind);
      if (known) return known;
      let id: string | null;
      if (kind === 'expense') {
        id = catalog.matchGroup('expense', OTHER_GROUP_NAME[settings.locale]);
      } else {
        const rows = catalog.groupsByKind[kind];
        id =
          (rows.find((g) => g.templateKey === DEFAULT_GROUP_TEMPLATE[kind]) ?? rows[0])?.id ?? null;
      }
      if (!id) {
        const name =
          kind === 'expense'
            ? OTHER_GROUP_NAME[settings.locale]
            : DEFAULT_GROUP_NAME[kind][settings.locale];
        const created = await createCategoryGroupInTx(tx, ctx.householdId, { name, kind });
        catalog.groupsByKind[kind].push(created);
        id = created.id;
        groupsCreated += 1;
      }
      fallback.set(kind, id);
      return id;
    };

    const now = opts.now ?? new Date();
    const today = localDay(now, settings.timezone);
    // Goals on the lines about to be replaced, with what each has saved so far (kept as its
    // baseline if its line does not come back).
    const onOldLines = existingBudgetId
      ? await goalsOnBudget(tx, ctx.householdId, existingBudgetId)
      : [];
    const rolled = new Map<string, Awaited<ReturnType<typeof rolledBaselineInTx>>>();
    // One year view per budget, built before its lines are replaced.
    const oldViews: YearViewCache = new Map();
    for (const g of onOldLines) {
      if (!g.accountId) {
        rolled.set(g.id, await rolledBaselineInTx(tx, ctx.householdId, g, now, oldViews));
      }
    }

    // The budget itself.
    let budgetId: string;
    if (existingBudgetId) {
      await tx
        .delete(budgetLine)
        .where(
          and(
            eq(budgetLine.budgetId, existingBudgetId),
            eq(budgetLine.householdId, ctx.householdId),
          ),
        );
      budgetId = existingBudgetId;
    } else {
      budgetId = (
        await createBudgetInTx(tx, ctx, {
          startMonth: sheet.startMonth,
          name: budgetNameOf(sheet.startMonth, settings.locale),
        })
      ).id;
    }

    // Lines, each with its own category in the line's group.
    const categories = await tx
      .select({
        id: category.id,
        groupId: category.groupId,
        name: category.name,
        groupKind: categoryGroup.kind,
      })
      .from(category)
      .innerJoin(
        categoryGroup,
        and(
          eq(categoryGroup.id, category.groupId),
          eq(categoryGroup.householdId, category.householdId),
        ),
      )
      .where(and(eq(category.householdId, ctx.householdId), isNull(category.archivedAt)))
      .orderBy(asc(category.sort), asc(category.name), asc(category.id));
    const categoryByName = new Map<string, string>();
    // Same name and kind anywhere in the household: reusable only when it is the only one.
    const byKindAndName = new Map<string, string[]>();
    for (const c of categories) {
      const key = `${c.groupId}:${normalizeName(c.name)}`;
      if (!categoryByName.has(key)) categoryByName.set(key, c.id);
      const anywhere = `${c.groupKind}:${normalizeName(c.name)}`;
      byKindAndName.set(anywhere, [...(byKindAndName.get(anywhere) ?? []), c.id]);
    }
    const taken = new Set<string>();
    const savingLineId = new Map<string, string>();
    const lineIdByKey = new Map<string, string>();
    for (const [position, line] of sheet.lines.entries()) {
      const named = line.group ? (namedGroup.get(groupKey(line.kind, line.group)) ?? null) : null;
      // Expense lines always sit in a group; income and saving lines only when the sheet names one.
      const lineGroupId =
        named ?? (line.kind === 'expense' ? await fallbackGroup('expense') : null);
      const categoryGroupId = lineGroupId ?? (await fallbackGroup(line.kind));
      const key = `${categoryGroupId}:${normalizeName(line.name)}`;
      let categoryId = categoryByName.get(key);
      if (!categoryId) {
        const anywhere = byKindAndName.get(`${line.kind}:${normalizeName(line.name)}`);
        if (anywhere?.length === 1 && !taken.has(anywhere[0]!)) categoryId = anywhere[0];
      }
      if (!categoryId) {
        categoryId = (
          await createCategoryInTx(tx, ctx.householdId, {
            groupId: categoryGroupId,
            name: line.name,
          })
        ).id;
        categoryByName.set(key, categoryId);
        categoriesCreated += 1;
      }
      taken.add(categoryId);
      const saved = await upsertBudgetLineInTx(tx, ctx.householdId, budgetId, {
        kind: line.kind,
        name: line.name,
        groupId: lineGroupId,
        accountId: accountOf(line.account),
        position,
      });
      if (line.kind === 'saving') savingLineId.set(normalizeName(line.name), saved.id);
      if (!lineIdByKey.has(lineKey(line.kind, line.name))) {
        lineIdByKey.set(lineKey(line.kind, line.name), saved.id);
      }
      await setLineAmountsInTx(tx, ctx.householdId, saved.id, line.amounts);
      await linkCategoriesInTx(tx, ctx.householdId, saved.id, [categoryId]);
    }

    // Deleting the lines unlinked their goals (SET NULL): each goes back to the new line of the
    // same kind and name; one whose line is gone keeps what it had saved as its baseline.
    const unlinked: typeof onOldLines = [];
    for (const g of onOldLines) {
      const newLineId = lineIdByKey.get(g.lineKey);
      const set = newLineId ? { budgetLineId: newLineId } : rolled.get(g.id);
      if (!newLineId) unlinked.push(g);
      if (set) {
        await tx
          .update(goal)
          .set(set)
          .where(and(eq(goal.id, g.id), eq(goal.householdId, ctx.householdId)));
      }
    }

    const subscriptionsImported = await importSubscriptions(
      tx,
      ctx.householdId,
      settings.currency,
      sheet.subscriptions,
      accountOf,
    );

    const netWorth = await importNetWorth(
      tx,
      ctx.householdId,
      sheet,
      include,
      { links, suggestions: existingAccounts },
      savingLineId,
      settings.currency,
      { now, today },
    );

    // Stored net worth months the imported values reach are recomputed with them.
    const snapshotsRefreshed = netWorth.earliestValue
      ? await refreshStoredSnapshotsInTx(tx, ctx.householdId, netWorth.earliestValue, now)
      : 0;

    // Still without a line once Objetivos is written: say so.
    const unlinkedIds = unlinked.filter((g) => !g.archived).map((g) => g.id);
    if (unlinkedIds.length > 0) {
      const still = await tx
        .select({ name: goal.name })
        .from(goal)
        .where(
          and(
            eq(goal.householdId, ctx.householdId),
            inArray(goal.id, unlinkedIds),
            isNull(goal.budgetLineId),
          ),
        )
        .orderBy(asc(goal.position), asc(goal.name), asc(goal.id));
      for (const g of still) {
        netWorth.warnings.push({ code: 'goal_unlinked', params: { name: g.name } });
      }
    }

    if (sheet.emergencyFundMonths !== null) {
      await tx
        .update(householdSettings)
        .set({ emergencyFundMonths: sheet.emergencyFundMonths })
        .where(eq(householdSettings.householdId, ctx.householdId));
    }
    await tx.update(undoToken).set({ usedAt: new Date() }).where(eq(undoToken.id, held.id));

    return {
      budgetId,
      replaced: existingBudgetId !== null,
      accountsCreated,
      groupsCreated,
      categoriesCreated,
      linesImported: sheet.lines.length,
      subscriptionsImported,
      subscriptionsSkipped: sheet.subscriptionsSkipped,
      ...netWorth.counts,
      snapshotsRefreshed,
      warnings: netWorth.warnings,
    };
  });
}

/**
 * Imported subscriptions are keyed like declared ones (`merchant_key` `d:<normalised name>`), so
 * payment detection treats them the same way. Importing again updates the row of the same service
 * (found by the new key or by the legacy `i:<name>` key, which is migrated) instead of adding a
 * second one. Detected and declared rows are never touched. Returns how many rows were written.
 */
async function importSubscriptions(
  tx: Tx,
  householdId: string,
  currency: string,
  subscriptions: ParsedSubscription[],
  accountOf: (name: string | null) => string | null,
): Promise<number> {
  const used = new Set<string>();
  const keyed = subscriptions.map((s) => {
    const base = `d:${normalizeDescription(s.name) || s.name}`;
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base}#${n}`;
    used.add(key);
    return { key, s };
  });
  if (keyed.length === 0) return 0;
  const legacyOf = (key: string) => `i:${key.slice(2)}`;
  const existing = new Map(
    (
      await tx
        .select({ id: recurring.id, merchantKey: recurring.merchantKey })
        .from(recurring)
        .where(
          and(
            eq(recurring.householdId, householdId),
            eq(recurring.source, 'import'),
            inArray(recurring.merchantKey, [
              ...keyed.map((k) => k.key),
              ...keyed.map((k) => legacyOf(k.key)),
            ]),
          ),
        )
    ).map((r) => [r.merchantKey, r.id]),
  );
  for (const { key, s } of keyed) {
    const values = {
      name: s.name,
      amount: s.amount,
      currency,
      cadence: s.cadence,
      accountId: accountOf(s.account),
    };
    const id = existing.get(key) ?? existing.get(legacyOf(key));
    if (id) {
      await tx
        .update(recurring)
        .set({ ...values, merchantKey: key })
        .where(and(eq(recurring.id, id), eq(recurring.householdId, householdId)));
    } else {
      await tx.insert(recurring).values({
        ...values,
        householdId,
        merchantKey: key,
        status: 'confirmed',
        source: 'import',
      });
    }
  }
  return keyed.length;
}
