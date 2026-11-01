/**
 * Demo data: a deterministic, fictional household for screenshots and for contributors who want
 * to explore Arfolio with realistic numbers. Everything is invented: merchants, employer, bank and
 * the specimen IBAN endings (DE89370400440532013000, PT50000201231234567890154).
 *
 * It fills an EXISTING household (created by the normal /setup flow) through the same services
 * the app uses, so row-level security and the service invariants hold. Only the booked
 * transactions, which are hundreds of rows, are bulk-inserted inside one household transaction.
 * The same `seed`, `months`, `locale` and `now` always produce the same rows (ids aside).
 */
import { createHash } from 'node:crypto';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { addAssetValuation, createAsset } from '../assets.js';
import { createAccount } from '../accounts.js';
import { createBudget, listBudgets, saveBudgetLine, setHubAccount } from '../budgets.js';
import { ensureHouseholdDefaults, TRANSFER_CATEGORY_KEY } from '../category-templates.js';
import type { ServiceCtx } from '../context.js';
import { createGoal } from '../goals.js';
import { createLiability } from '../liabilities.js';
import { householdToday, monthStart, snapshotNetWorth } from '../net-worth.js';

const { category, member, positionSnapshot, transaction } = schema;

export interface SeedDemoOptions {
  householdId: string;
  /** Complete months of history before the current (partial) month. */
  months: number;
  /** Language of the descriptions and of the account, budget and goal names. */
  locale: 'en' | 'pt-PT';
  /** PRNG seed; the default is fixed so every run builds the same household. */
  seed?: number;
  /** "Today", for tests; defaults to the current time. */
  now?: Date;
  /** Seed even if the household already has transactions. */
  force?: boolean;
}

export const DEFAULT_DEMO_SEED = 20_260_101;

/** The household cannot be seeded (it already has data, or lacks something the seed needs). */
export class DemoSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoSeedError';
  }
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function addMonths(month: string, delta: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

const dayOf = (month: string, day: number): string =>
  `${month.slice(0, 8)}${String(day).padStart(2, '0')}`;

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A stable uuid-shaped id derived from a label (used for transfer groups). */
function stableUuid(label: string): string {
  const h = createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Monthly payment of an annuity loan, in minor units. */
function annuityPayment(principal: number, annualRateBps: number, termMonths: number): number {
  const r = annualRateBps / 10_000 / 12;
  return Math.round((principal * r) / (1 - (1 + r) ** -termMonths));
}

type AccountKey = 'checking' | 'savings' | 'card';
type CategoryKey =
  | 'income.salary'
  | 'income.interest_dividends'
  | 'housing.mortgage_rent'
  | 'housing.community_fees'
  | 'housing.utilities'
  | 'housing.communications'
  | 'food.groceries'
  | 'food.restaurants'
  | 'transport.fuel'
  | 'transport.public'
  | 'transport.car_insurance'
  | 'leisure.subscriptions'
  | 'leisure.travel'
  | 'leisure.leisure'
  | 'leisure.online_shopping'
  | 'personal.health'
  | 'personal.sports'
  | typeof TRANSFER_CATEGORY_KEY;

interface PlannedTransaction {
  account: AccountKey;
  date: string;
  /** Signed minor units. */
  amount: number;
  description: string;
  counterparty: string | null;
  category: CategoryKey;
  transferGroupId?: string;
}

const CATEGORY_KEYS: readonly CategoryKey[] = [
  'income.salary',
  'income.interest_dividends',
  'housing.mortgage_rent',
  'housing.community_fees',
  'housing.utilities',
  'housing.communications',
  'food.groceries',
  'food.restaurants',
  'transport.fuel',
  'transport.public',
  'transport.car_insurance',
  'leisure.subscriptions',
  'leisure.travel',
  'leisure.leisure',
  'leisure.online_shopping',
  'personal.health',
  'personal.sports',
  TRANSFER_CATEGORY_KEY,
];

const SALARY = 290_000;
const SAVINGS_TRANSFER = 35_000;
const MORTGAGE = { principal: 19_000_000, rateBps: 310, termMonths: 360 };
const PROPERTY_VALUE = 24_500_000;
/** Invented funds (tickers and names do not exist). Minor units; value above cost. */
const HOLDINGS = [
  {
    ticker: 'EXWD',
    name: 'Example World Index Fund',
    quantity: '84.5',
    price: 10_840,
    cost: 790_000,
  },
  {
    ticker: 'EXEU',
    name: 'Example Europe Equity Fund',
    quantity: '42',
    price: 13_250,
    cost: 520_000,
  },
  { ticker: 'EXBD', name: 'Example Euro Bond Fund', quantity: '60', price: 4_905, cost: 285_000 },
] as const;

export async function seedDemoHousehold(db: Db, opts: SeedDemoOptions): Promise<void> {
  const { householdId, months, locale } = opts;
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new DemoSeedError('months must be a whole number between 1 and 120');
  }
  const now = opts.now ?? new Date();
  const rand = prng(opts.seed ?? DEFAULT_DEMO_SEED);
  const between = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const L = (en: string, pt: string): string => (locale === 'pt-PT' ? pt : en);
  /** Splits `total` into `parts` positive amounts (the last takes the rounding remainder). */
  const split = (total: number, parts: number): number[] => {
    const weights = Array.from({ length: parts }, () => 0.5 + rand());
    const sum = weights.reduce((a, b) => a + b, 0);
    const out = weights.map((w) => Math.round((total * w) / sum));
    out[parts - 1] = total - out.slice(0, -1).reduce((a, b) => a + b, 0);
    return out;
  };

  const owner = await withHousehold(db, householdId, async (tx) => {
    const [existing] = await tx
      .select({ n: count() })
      .from(transaction)
      .where(eq(transaction.householdId, householdId));
    if (existing!.n > 0 && !opts.force) {
      throw new DemoSeedError(
        'The household already has transactions; use force (--force on the command line) to seed it anyway',
      );
    }
    const [row] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, householdId), eq(member.role, 'owner')))
      .limit(1);
    return row?.userId ?? 'demo-seed';
  });
  const ctx: ServiceCtx = { db, householdId, userId: owner, role: 'owner' };

  await ensureHouseholdDefaults(ctx);
  const { currency, today } = await householdToday(ctx, now);
  const categories = await withHousehold(db, householdId, (tx) =>
    tx
      .select({ id: category.id, name: category.name, templateKey: category.templateKey })
      .from(category)
      .where(
        and(
          eq(category.householdId, householdId),
          isNotNull(category.templateKey),
          isNull(category.archivedAt),
        ),
      ),
  );
  const byKey = new Map(categories.map((c) => [c.templateKey!, c]));
  for (const key of CATEGORY_KEYS) {
    if (!byKey.has(key)) throw new DemoSeedError(`The household has no "${key}" category`);
  }
  const categoryOf = (key: CategoryKey) => byKey.get(key)!;

  // ---- Accounts --------------------------------------------------------------------------
  const currentMonth = monthStart(today);
  const firstMonth = addMonths(currentMonth, -months);
  const openingDate = dayBefore(firstMonth);
  const bank = L('Example Bank', 'Banco Exemplo');
  const accountIds = {} as Record<AccountKey, string>;
  const accountSpecs: Array<{ key: AccountKey; input: Parameters<typeof createAccount>[1] }> = [
    {
      key: 'checking',
      input: {
        name: L('Everyday account', 'Conta à ordem'),
        type: 'checking',
        institutionName: bank,
        ibanLast4: '0154',
        openingBalance: 240_000,
        openingBalanceDate: openingDate,
        sort: 0,
      },
    },
    {
      key: 'savings',
      input: {
        name: L('Savings', 'Poupança'),
        type: 'savings',
        institutionName: bank,
        ibanLast4: '3000',
        openingBalance: 150_000,
        openingBalanceDate: openingDate,
        sort: 1,
      },
    },
    {
      key: 'card',
      input: {
        name: L('Credit card', 'Cartão de crédito'),
        type: 'card',
        institutionName: bank,
        openingBalance: 0,
        openingBalanceDate: openingDate,
        includeInBudget: true,
        sort: 2,
      },
    },
  ];
  for (const { key, input } of accountSpecs) accountIds[key] = (await createAccount(ctx, input)).id;
  // Salary lands here: without a hub account the budget asks which account is the main one.
  await setHubAccount(ctx, accountIds.checking);
  // A small manual investment account, so Investments and net worth are not empty.
  const investment = await createAccount(ctx, {
    name: L('Index fund account', 'Conta de fundos de índice'),
    type: 'investment',
    institutionName: bank,
    openingBalance: HOLDINGS.reduce((sum, h) => sum + h.cost, 0),
    openingBalanceDate: openingDate,
    sort: 3,
  });

  // ---- Transactions ----------------------------------------------------------------------
  const planned: PlannedTransaction[] = [];
  const add = (
    account: AccountKey,
    date: string,
    amount: number,
    category: CategoryKey,
    counterparty: string | null,
    description?: string,
  ): void => {
    if (date > today) return;
    planned.push({
      account,
      date,
      amount,
      description: description ?? counterparty ?? '',
      counterparty,
      category,
    });
  };
  const monthlyPayment = annuityPayment(MORTGAGE.principal, MORTGAGE.rateBps, MORTGAGE.termMonths);

  for (let m = 0; m <= months; m++) {
    const month = addMonths(firstMonth, m);
    const at = (day: number): string => dayOf(month, day);
    const cardStart = planned.length;

    add(
      'checking',
      at(25),
      SALARY,
      'income.salary',
      'Brightfield Labs',
      L('Salary Brightfield Labs', 'Vencimento Brightfield Labs'),
    );
    add(
      'checking',
      at(5),
      -monthlyPayment,
      'housing.mortgage_rent',
      'Harbour Home Loans',
      L('Home loan instalment', 'Prestação crédito habitação'),
    );
    add(
      'checking',
      at(5),
      -4_500,
      'housing.community_fees',
      'Residencial Jardim',
      L('Building fees', 'Condomínio'),
    );
    add('checking', at(8), -3_990, 'housing.communications', 'Fibra Azul Telecom');
    add('checking', at(12), -between(5_500, 8_500), 'housing.utilities', 'Northwind Energy');
    add('checking', at(15), -between(2_400, 3_200), 'housing.utilities', 'Aqua Verde Water');
    add(
      'checking',
      at(1),
      -4_000,
      'transport.public',
      'City Transit Pass',
      L('Monthly transit pass', 'Passe mensal'),
    );
    add('checking', at(20), -3_800, 'transport.car_insurance', 'Shield Insurance');
    for (const amount of split(between(9_500, 11_500), 2)) {
      add('checking', at(between(2, 27)), -amount, 'transport.fuel', 'Petro Norte');
    }
    const trips = split(between(44_000, 48_000), 7);
    trips.forEach((amount, i) => {
      add(
        'checking',
        at(2 + i * 4),
        -amount,
        'food.groceries',
        i % 3 === 2 ? 'Fresh Corner Market' : 'Mercado Central',
      );
    });
    if (m % 2 === 1)
      add(
        'checking',
        at(between(2, 27)),
        -between(1_200, 3_500),
        'personal.health',
        'Farmácia Esperança',
      );

    // On the card: restaurants stay just under their budget, the rest is small and regular.
    const restaurantTotal = between(14_200, 15_800);
    split(restaurantTotal, between(4, 6)).forEach((amount, i) => {
      add(
        'card',
        at(3 + i * 4 + between(0, 2)),
        -amount,
        'food.restaurants',
        pick(['Café Girassol', 'Trattoria Bella Vista', 'Sushi Lua']),
      );
    });
    add('card', at(3), -1_299, 'leisure.subscriptions', 'StreamBox');
    add('card', at(9), -299, 'leisure.subscriptions', 'Cloudbox Storage');
    add('card', at(1), -2_990, 'personal.sports', 'Pulse Fitness');
    for (let i = 0; i < 2; i++)
      add('card', at(between(4, 26)), -between(800, 3_000), 'leisure.leisure', 'Cinema Estrela');
    if (m % 3 === 2)
      add(
        'card',
        at(between(4, 26)),
        -between(2_500, 9_000),
        'leisure.online_shopping',
        'Bluebird Shop',
      );
    if (m === 4 || m === 9) {
      add('card', at(14), -34_000, 'leisure.travel', 'Skyline Air', L('Flights', 'Voos'));
      add('card', at(17), -52_000, 'leisure.travel', 'Hotel Aurora');
    }

    // Savings: a monthly transfer in, a little interest, and the card paid off on the 28th.
    const groupId = stableUuid(`demo:${opts.seed ?? DEFAULT_DEMO_SEED}:save:${month}`);
    const saveLabel = L('Transfer to savings', 'Transferência para poupança');
    if (at(26) <= today) {
      planned.push(
        {
          account: 'checking',
          date: at(26),
          amount: -SAVINGS_TRANSFER,
          description: saveLabel,
          counterparty: null,
          category: TRANSFER_CATEGORY_KEY,
          transferGroupId: groupId,
        },
        {
          account: 'savings',
          date: at(26),
          amount: SAVINGS_TRANSFER,
          description: saveLabel,
          counterparty: null,
          category: TRANSFER_CATEGORY_KEY,
          transferGroupId: groupId,
        },
      );
    }
    add(
      'savings',
      at(28),
      between(180, 260),
      'income.interest_dividends',
      bank,
      L('Interest', 'Juros'),
    );
    const owed = -planned
      .slice(cardStart)
      .filter((p) => p.account === 'card')
      .reduce((sum, p) => sum + p.amount, 0);
    if (at(28) <= today && owed > 0) {
      const payId = stableUuid(`demo:${opts.seed ?? DEFAULT_DEMO_SEED}:card:${month}`);
      const label = L('Credit card payment', 'Pagamento do cartão');
      planned.push(
        {
          account: 'checking',
          date: at(28),
          amount: -owed,
          description: label,
          counterparty: null,
          category: TRANSFER_CATEGORY_KEY,
          transferGroupId: payId,
        },
        {
          account: 'card',
          date: at(28),
          amount: owed,
          description: label,
          counterparty: null,
          category: TRANSFER_CATEGORY_KEY,
          transferGroupId: payId,
        },
      );
    }
  }

  planned.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.account.localeCompare(b.account) || a.amount - b.amount,
  );
  const seedTag = opts.seed ?? DEFAULT_DEMO_SEED;
  const rows: Array<typeof transaction.$inferInsert> = planned.map((p, i) => ({
    householdId,
    accountId: accountIds[p.account],
    dedupeHash: createHash('sha256').update(`demo:${seedTag}:${i}`).digest('hex'),
    bookingDate: p.date,
    amount: p.amount,
    currency,
    status: 'booked',
    rawDescription: p.description,
    counterparty: p.counterparty,
    categoryId: categoryOf(p.category).id,
    categorisedBy: 'user',
    needsReview: false,
    source: 'manual',
    ...(p.transferGroupId ? { transferGroupId: p.transferGroupId, transferLocked: true } : {}),
  }));
  await withHousehold(db, householdId, async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(transaction).values(rows.slice(i, i + 500));
    }
  });

  // ---- Holdings (manual snapshot on today's date) ------------------------------------------
  await withHousehold(db, householdId, async (tx) => {
    await tx.insert(positionSnapshot).values(
      HOLDINGS.map((h) => {
        const value = Math.round(Number(h.quantity) * h.price);
        return {
          householdId,
          accountId: investment.id,
          asOf: today,
          instrument: h.ticker,
          ticker: h.ticker,
          name: h.name,
          quantity: h.quantity,
          priceMinor: h.price,
          valueMinor: value,
          currency,
          costMinor: h.cost,
          unrealizedPlMinor: value - h.cost,
        };
      }),
    );
  });

  // ---- Property, mortgage and goal -------------------------------------------------------
  const property = await createAsset(ctx, {
    kind: 'real_estate',
    name: L('Apartment', 'Apartamento'),
  });
  for (let k = 0; addMonths(firstMonth, k * 3) <= today; k++) {
    await addAssetValuation(ctx, property.id, {
      asOf: addMonths(firstMonth, k * 3),
      value: Math.round(PROPERTY_VALUE * (1 + 0.009 * k)),
    });
  }
  await createLiability(ctx, {
    kind: 'mortgage',
    name: L('Home loan', 'Crédito habitação'),
    assetId: property.id,
    principal: MORTGAGE.principal,
    annualRateBps: MORTGAGE.rateBps,
    termMonths: MORTGAGE.termMonths,
    startDate: addMonths(firstMonth, -60),
  });
  await createGoal(
    ctx,
    {
      name: L('Summer holiday fund', 'Fundo para as férias'),
      targetAmount: 800_000,
      targetDate: dayOf(addMonths(currentMonth, 8), 1),
      accountId: accountIds.savings,
      monthlyContribution: SAVINGS_TRANSFER,
    },
    { now },
  );

  // ---- Budget ----------------------------------------------------------------------------
  // A 12-month budget that ends with the current month, so every seeded month is covered.
  const budgetStart = addMonths(currentMonth, -Math.min(months, 11));
  // A forced re-seed must not collide with the budget of a previous run (a start month holds one).
  if (!(await listBudgets(ctx)).some((b) => b.startMonth === budgetStart)) {
    const budget = await createBudget(ctx, {
      startMonth: budgetStart,
      name: L('Household budget', 'Orçamento da casa'),
    });
    const flat = (amount: number): number[] => Array.from({ length: 12 }, () => amount);
    const lines: Array<{ kind: 'income' | 'expense'; key: CategoryKey; planned: number }> = [
      { kind: 'income', key: 'income.salary', planned: SALARY },
      { kind: 'expense', key: 'housing.mortgage_rent', planned: monthlyPayment },
      { kind: 'expense', key: 'housing.utilities', planned: 13_000 },
      { kind: 'expense', key: 'housing.communications', planned: 4_000 },
      { kind: 'expense', key: 'food.groceries', planned: 40_000 },
      { kind: 'expense', key: 'food.restaurants', planned: 16_000 },
      { kind: 'expense', key: 'transport.fuel', planned: 12_000 },
      { kind: 'expense', key: 'leisure.subscriptions', planned: 2_000 },
      { kind: 'expense', key: 'leisure.leisure', planned: 6_000 },
    ];
    // The monthly transfer to savings is planned too, so the budget shows it as met.
    await saveBudgetLine(ctx, budget.id, {
      line: { kind: 'saving', name: L('Savings', 'Poupança'), accountId: accountIds.savings },
      amounts: flat(SAVINGS_TRANSFER),
      categoryIds: [],
    });
    for (const line of lines) {
      const cat = categoryOf(line.key);
      await saveBudgetLine(ctx, budget.id, {
        line: { kind: line.kind, name: cat.name },
        amounts: flat(line.planned),
        categoryIds: [cat.id],
      });
    }
  }

  // ---- Net worth history -----------------------------------------------------------------
  for (let m = 0; m < months; m++) {
    await snapshotNetWorth({ db, now }, householdId, addMonths(firstMonth, m));
  }
}
