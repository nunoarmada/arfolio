import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import {
  PASSWORD,
  axeViolations,
  nativeSubmit,
  newOwnerContext,
  shoot,
  signInOwner,
  watch,
} from './helpers';

const VIEWER = { email: 'vic@example.com' };

/**
 * The warning sentence the seeded month gets, on any day of the month (src/lib/budget-status.ts).
 * Phase 3 leaves Renda (one row, the whole plan) and Supermercado (one row, over half the plan)
 * booked on day 1: both are lump sums, so the pace test leaves them out, and what remains
 * (Diversos, Cinema) has nothing booked. "Ahead of the pace" can therefore never fire here, and
 * the month is always flagged by the near-limit rule (about 90% of the plan spent). That
 * sentence is covered by the unit tests of summaryStatus.
 */
const BUDGET_WARNING = 'Atenção: perto do limite do previsto';
const PACE_WARNING = 'Atenção: a gastar acima do ritmo do mês';

/** Runs SQL as the database owner (bypasses RLS): seeding and inspection only, never the app. */
async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

const householdId = async (): Promise<string> =>
  (await sql<{ id: string }>('select id from organization limit 1'))[0]!.id;

const MONEY = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
});
/** Minor units as the app writes them in pt-PT ("1 240,00 €"). */
const eur = (cents: number): string => MONEY.format(cents / 100);

/** Today in the household's time zone and the dates the spec derives from it. */
async function calendar() {
  const timezone = (
    await sql<{ timezone: string }>('select timezone from household_settings limit 1')
  )[0]!.timezone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const day = (offsetDays: number): string =>
    new Date(Date.UTC(get('year'), get('month') - 1, get('day') + offsetDays))
      .toISOString()
      .slice(0, 10);
  const month = (delta: number): string => {
    const total = get('year') * 12 + get('month') - 1 + delta;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  };
  return {
    day,
    month,
    dayOfMonth: get('day'),
    daysInMonth: new Date(Date.UTC(get('year'), get('month'), 0)).getUTCDate(),
  };
}

// ---------------------------------------------------------------------------------------------
// Seeding. Every helper puts back what it found, so the specs around this one see the same data.

interface RecurringSeed {
  name: string;
  /** Signed minor units. */
  amount: number;
  on: string | null;
  currency?: string;
  status?: 'confirmed' | 'detected';
}

/**
 * Runs `fn` with exactly these recurring items: the existing ones are set aside (dismissed) and
 * put back, the seeded ones are removed.
 */
async function withRecurring(items: RecurringSeed[], fn: () => Promise<void>): Promise<void> {
  const hid = await householdId();
  const before = await sql<{ id: string; status: string }>('select id, status from recurring');
  await sql(`update recurring set status = 'dismissed' where status <> 'dismissed'`);
  const ids: string[] = [];
  try {
    for (const [i, item] of items.entries()) {
      const row = await sql<{ id: string }>(
        `insert into recurring (household_id, merchant_key, name, amount, currency, cadence,
           next_expected_on, status, source)
         values ($1, $2, $3, $4, $5, 'monthly', $6, $7, 'declared') returning id`,
        [
          hid,
          `p5-seed-${i}`,
          item.name,
          item.amount,
          item.currency ?? 'EUR',
          item.on,
          item.status ?? 'confirmed',
        ],
      );
      ids.push(row[0]!.id);
    }
    await fn();
  } finally {
    await sql('delete from recurring where id = any($1)', [ids]);
    await sql(
      `update recurring r set status = b.status
         from jsonb_to_recordset($1::jsonb) as b(id uuid, status text) where r.id = b.id`,
      [JSON.stringify(before)],
    );
  }
}

/** Runs `fn` with every budget archived, so the household has none for the month. */
async function withoutBudgets(fn: () => Promise<void>): Promise<void> {
  const before = await sql<{ id: string; status: string }>('select id, status from budget');
  await sql(`update budget set status = 'archived' where status <> 'archived'`);
  try {
    await fn();
  } finally {
    await sql(
      `update budget b set status = s.status
         from jsonb_to_recordset($1::jsonb) as s(id uuid, status text) where b.id = s.id`,
      [JSON.stringify(before)],
    );
  }
}

/** Runs `fn` with these stored past-month net worth values (oldest first) and no others. */
async function withSnapshots(
  months: Array<{ month: string; net: number }>,
  fn: () => Promise<void>,
): Promise<void> {
  const hid = await householdId();
  const stash = await sql<{
    month: string;
    assets: string;
    liabilities: string;
    net: string;
    breakdown: unknown;
    computed_at: Date;
  }>(
    `select month::text, assets, liabilities, net, breakdown, computed_at from net_worth_snapshot`,
  );
  await sql('delete from net_worth_snapshot');
  try {
    for (const m of months) {
      await sql(
        `insert into net_worth_snapshot (household_id, month, assets, liabilities, net, breakdown)
         values ($1, $2, $3, 0, $3, '{}'::jsonb)`,
        [hid, m.month, m.net],
      );
    }
    await fn();
  } finally {
    await sql('delete from net_worth_snapshot');
    for (const s of stash) {
      await sql(
        `insert into net_worth_snapshot (household_id, month, assets, liabilities, net, breakdown,
           computed_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [hid, s.month, s.assets, s.liabilities, s.net, JSON.stringify(s.breakdown), s.computed_at],
      );
    }
  }
}

/** Runs `fn` while a table is missing, so everything that reads it fails (put back after). */
async function withoutTable(table: string, fn: () => Promise<void>): Promise<void> {
  await sql(`alter table ${table} rename to ${table}_hold`);
  try {
    await fn();
  } finally {
    await sql(`alter table ${table}_hold rename to ${table}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Assertions

/** Axe on the current page in light and dark. */
async function expectAccessible(page: Page): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(
      (name) => matchMedia(`(prefers-color-scheme: ${name})`).matches,
      scheme,
    );
    expect(await axeViolations(page), `axe (${scheme}) at ${page.url()}`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** No page-level horizontal scroll, and every block (by test id prefix) sits inside the viewport. */
async function expectNoOverflow(page: Page, prefix = 'home-'): Promise<void> {
  const { overflow, outside } = await page.evaluate((testIdPrefix) => {
    const width = document.documentElement.clientWidth;
    return {
      overflow: document.documentElement.scrollWidth - width,
      outside: [...document.querySelectorAll(`[data-testid^="${testIdPrefix}"]`)]
        .filter((el) => el.getBoundingClientRect().right > width + 0.5)
        .map((el) => el.getAttribute('data-testid')),
    };
  }, prefix);
  expect(overflow, `page overflow at ${page.url()}`).toBeLessThanOrEqual(0);
  expect(outside, `blocks wider than the viewport at ${page.url()}`).toEqual([]);
}

/** A screenshot at the viewport the page is at (the 320px checks), when screenshots are on. */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------------------------
// Análises: a window of seeded transactions eight years back, where no other spec has data, so
// every figure on the page can be checked against numbers worked out by hand.

interface InsightsData {
  /** `yyyy-mm-01` of the months of the window: the last (`e`), the two before and an early one. */
  m: { e: string; e1: string; e2: string; e5: string };
  /** `yyyy-mm`, for `?end=`. */
  endParam: string;
  ids: {
    casa: string;
    lazer: string;
    renda: string;
    luz: string;
    cinema: string;
    accountA: string;
    accountB: string;
  };
  /** A date of the month `month` (`yyyy-mm-01`) on day `d`. */
  on: (month: string, d: number) => string;
  /** The last day of the month `month` (`yyyy-mm-01`). */
  lastDay: (month: string) => string;
}

const lastDayOf = (month: string): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return `${month.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * Runs `fn` with two euro accounts, one in dollars, two spending groups, an income group and
 * these movements (cents), then removes all of it:
 * - last month: rent -800,00 and electricity -60,00 (Casa), cinema -25,00 with a +5,00 refund
 *   (Lazer), an uncategorised -15,00 and +3,00, a salary +2000,00, a transfer of 500,00 between
 *   the two accounts, a pending electricity bill -9,99 and a dollar row (Lazer, -12,34);
 * - the month before: rent -700,00, salary +1900,00, interest +10,00 on the second account;
 * - two months before: rent -700,00, cinema -30,00, salary +1900,00;
 * - five months before: salary +1000,00.
 */
async function withInsightsData(
  cal: Awaited<ReturnType<typeof calendar>>,
  fn: (data: InsightsData) => Promise<void>,
): Promise<void> {
  const hid = await householdId();
  const m = { e: cal.month(-100), e1: cal.month(-101), e2: cal.month(-102), e5: cal.month(-105) };
  const on = (month: string, d: number) => `${month.slice(0, 7)}-${String(d).padStart(2, '0')}`;
  const one = async (text: string, values: unknown[]) =>
    (await sql<{ id: string }>(text, values))[0]!.id;
  const accountIds: string[] = [];
  const categoryIds: string[] = [];
  const groupIds: string[] = [];
  try {
    const account = async (name: string, type: string, currency: string) => {
      const id = await one(
        `insert into financial_account (household_id, name, type, currency)
         values ($1, $2, $3, $4) returning id`,
        [hid, name, type, currency],
      );
      accountIds.push(id);
      return id;
    };
    const group = async (name: string, kind: string) => {
      const id = await one(
        `insert into category_group (household_id, name, kind, sort) values ($1, $2, $3, 90)
         returning id`,
        [hid, name, kind],
      );
      groupIds.push(id);
      return id;
    };
    const category = async (groupId: string, name: string) => {
      const id = await one(
        `insert into category (household_id, group_id, name) values ($1, $2, $3) returning id`,
        [hid, groupId, name],
      );
      categoryIds.push(id);
      return id;
    };
    const accountA = await account('P5 Corrente', 'checking', 'EUR');
    const accountB = await account('P5 Poupança', 'savings', 'EUR');
    const accountC = await account('P5 Dólares', 'checking', 'USD');
    const casa = await group('P5 Casa', 'expense');
    const lazer = await group('P5 Lazer', 'expense');
    const rendimento = await group('P5 Rendimento', 'income');
    const renda = await category(casa, 'P5 Renda');
    const luz = await category(casa, 'P5 Luz');
    const cinema = await category(lazer, 'P5 Cinema');
    const salario = await category(rendimento, 'P5 Salário');
    const transferCategory = await one(
      `select id from category where household_id = $1 and template_key = 'transfer.between_accounts'`,
      [hid],
    );
    const transfer = crypto.randomUUID();

    type Seed = [account: string, date: string, cents: number, what: string, category?: string];
    const rows: Seed[] = [
      [accountA, on(m.e, 5), -80000, 'P5 Renda', renda],
      [accountA, on(m.e, 5), -6000, 'P5 Luz', luz],
      [accountA, on(m.e, 7), -2500, 'P5 Cinema', cinema],
      [accountA, on(m.e, 8), 500, 'P5 Reembolso cinema', cinema],
      [accountA, on(m.e, 9), -1500, 'P5 Sem categoria'],
      [accountA, on(m.e, 9), 300, 'P5 Devolução'],
      [accountA, on(m.e, 10), 200000, 'P5 Salário', salario],
      [accountA, on(m.e, 12), -50000, 'P5 Transferência saída', transferCategory],
      [accountB, on(m.e, 12), 50000, 'P5 Transferência entrada', transferCategory],
      [accountA, on(m.e1, 5), -70000, 'P5 Renda', renda],
      [accountA, on(m.e1, 10), 190000, 'P5 Salário', salario],
      [accountB, on(m.e1, 15), 1000, 'P5 Juros'],
      [accountA, on(m.e2, 5), -70000, 'P5 Renda', renda],
      [accountA, on(m.e2, 6), -3000, 'P5 Cinema', cinema],
      [accountA, on(m.e2, 10), 190000, 'P5 Salário', salario],
      [accountA, on(m.e5, 10), 100000, 'P5 Salário', salario],
    ];
    const payload = [
      ...rows.map(([acc, date, amount, what, cat], i) => ({
        account_id: acc,
        hash: `p5-ins-${i}`,
        date,
        amount,
        currency: 'EUR',
        status: 'booked',
        description: what,
        category_id: cat ?? null,
        tg: cat === transferCategory ? transfer : null,
      })),
      {
        account_id: accountA,
        hash: 'p5-ins-pending',
        date: on(m.e, 5),
        amount: -999,
        currency: 'EUR',
        status: 'pending',
        description: 'P5 Luz pendente',
        category_id: luz,
        tg: null,
      },
      {
        account_id: accountC,
        hash: 'p5-ins-usd',
        date: on(m.e, 14),
        amount: -1234,
        currency: 'USD',
        status: 'booked',
        description: 'P5 Dólares',
        category_id: cinema,
        tg: null,
      },
    ];
    await sql(
      `insert into transaction (household_id, account_id, dedupe_hash, booking_date, amount,
         currency, status, raw_description, category_id, categorised_by, transfer_group_id, source)
       select $1, r.account_id, r.hash, r.date, r.amount, r.currency, r.status, r.description,
         r.category_id, case when r.category_id is null then null else 'user' end, r.tg, 'manual'
       from jsonb_to_recordset($2::jsonb) as r(account_id uuid, hash text, date date,
         amount bigint, currency text, status text, description text, category_id uuid, tg uuid)`,
      [hid, JSON.stringify(payload)],
    );
    await fn({
      m,
      endParam: m.e.slice(0, 7),
      ids: { casa, lazer, renda, luz, cinema, accountA, accountB },
      on,
      lastDay: lastDayOf,
    });
  } finally {
    // The accounts take their movements with them; the categories can go once nothing uses them.
    await sql('delete from financial_account where id = any($1)', [accountIds]);
    await sql('delete from category where id = any($1)', [categoryIds]);
    await sql('delete from category_group where id = any($1)', [groupIds]);
  }
}

/**
 * On top of `withInsightsData`: an active budget year with a saving line on the savings account
 * (so transfers into it count as saving), a transfer in one month (+300,00 saving) and out of it
 * the next (-200,00 saving), a month with rent and no income (a deficit of 700,00) and two rows
 * in the current period for the live month. The budget goes away in a `finally`; the rows go
 * with the accounts.
 */
async function withCaptureExtras(
  cal: Awaited<ReturnType<typeof calendar>>,
  d: InsightsData,
  fn: () => Promise<void>,
): Promise<void> {
  const hid = await householdId();
  const userId = (await sql<{ id: string }>('select id from "user" limit 1'))[0]!.id;
  const transferCategory = (
    await sql<{ id: string }>(
      `select id from category where household_id = $1 and template_key = 'transfer.between_accounts'`,
      [hid],
    )
  )[0]!.id;
  const e3 = cal.month(-103);
  const budgetId = (
    await sql<{ id: string }>(
      `insert into budget (household_id, start_month, name, status, created_by)
       values ($1, $2, 'P5 Orçamento antigo', 'active', $3) returning id`,
      [hid, cal.month(-110), userId],
    )
  )[0]!.id;
  try {
    await sql(
      `insert into budget_line (household_id, budget_id, kind, name, account_id)
       values ($1, $2, 'saving', 'P5 Poupança', $3)`,
      [hid, budgetId, d.ids.accountB],
    );
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    const rows = [
      [d.ids.accountA, d.on(d.m.e1, 20), -30000, 'P5 Para poupança', transferCategory, first],
      [d.ids.accountB, d.on(d.m.e1, 20), 30000, 'P5 Para poupança', transferCategory, first],
      [d.ids.accountB, d.on(d.m.e2, 20), -20000, 'P5 Da poupança', transferCategory, second],
      [d.ids.accountA, d.on(d.m.e2, 20), 20000, 'P5 Da poupança', transferCategory, second],
      [d.ids.accountA, d.on(e3, 5), -70000, 'P5 Renda', d.ids.renda, null],
      [d.ids.accountA, cal.day(-0), 100000, 'P5 Salário de hoje', null, null],
      [
        d.ids.accountA,
        `${cal.month(-1).slice(0, 7)}-03`,
        -40000,
        'P5 Renda do mês passado',
        d.ids.renda,
        null,
      ],
    ].map(([account_id, date, amount, description, category_id, tg], i) => ({
      account_id,
      hash: `p5-cap-${i}`,
      date,
      amount,
      description,
      category_id,
      tg,
    }));
    await sql(
      `insert into transaction (household_id, account_id, dedupe_hash, booking_date, amount,
         currency, status, raw_description, category_id, categorised_by, transfer_group_id, source)
       select $1, r.account_id, r.hash, r.date, r.amount, 'EUR', 'booked', r.description,
         r.category_id, case when r.category_id is null then null else 'user' end, r.tg, 'manual'
       from jsonb_to_recordset($2::jsonb) as r(account_id uuid, hash text, date date,
         amount bigint, description text, category_id uuid, tg uuid)`,
      [hid, JSON.stringify(rows)],
    );
    await fn();
  } finally {
    await sql('delete from budget where id = $1', [budgetId]);
  }
}

/** A regular expression source for an amount as the app writes it (any kind of space inside). */
const money = (cents: number): string =>
  eur(cents)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s/g, '\\s');

/** Minor units from a displayed amount ("−1 234,56 €", "+500,00 €"); NaN when there is none. */
const centsOf = (text: string): number => {
  const clean = text
    .replace(/[^\d,−-]/g, '')
    .replace('−', '-')
    .replace(',', '.');
  return Math.round(Number(clean) * 100);
};

test.describe.configure({ mode: 'serial' });

test.describe('phase 5: home dashboard', () => {
  const problems: string[] = [];
  let browser: Browser;
  let page: Page;
  let cal: Awaited<ReturnType<typeof calendar>>;

  /** The seeded week: three payments of the household currency, one in dollars, three outside. */
  const week = (): RecurringSeed[] => [
    { name: 'P5 Ginásio', amount: -2990, on: cal.day(0) },
    { name: 'P5 Seguro', amount: -5407, on: cal.day(1) },
    { name: 'P5 Streaming', amount: -1299, on: cal.day(3) },
    { name: 'P5 Software', amount: -500, on: cal.day(2), currency: 'USD' },
    { name: 'P5 Longe', amount: -9900, on: cal.day(8) },
    { name: 'P5 Salário', amount: 200000, on: cal.day(2) },
    { name: 'P5 Talvez', amount: -1000, on: cal.day(2), status: 'detected' },
  ];
  /** Five months of stored history (oldest first); the live month comes from the real data. */
  const history = () =>
    [-5, -4, -3, -2, -1].map((delta, i) => ({
      month: cal.month(delta),
      net: 800_000 + i * 25_000,
    }));

  const upcoming = () => page.getByTestId('home-upcoming');
  const hero = () => page.getByRole('region', { name: /^Orçamento de/ });

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    page = await (await newOwnerContext(b)).newPage();
    watch(page, problems);
    await signInOwner(page);
    cal = await calendar();
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  // -------------------------------------------------------------------------------------------
  // The blocks, from data

  test('the blocks render from the household data and the old tiles are gone', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const waiting = (
      await sql<{ n: number }>('select count(*)::int as n from transaction where needs_review')
    )[0]!.n;
    const connections = (await sql<{ n: number }>('select count(*)::int as n from connection'))[0]!
      .n;
    await withSnapshots(history(), () =>
      withRecurring(week(), async () => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();

        // Hero: the sentence, what is left, the bar with today's pace and what it says.
        const card = page.getByTestId('home-budget-hero');
        await expect(hero()).toBeVisible();
        // Most of the plan spent: the sentence must not say "on track" over an amber bar, and
        // /budget says the same thing. The lump-sum lines keep it off the pace warning every day.
        await expect(card).toContainText(BUDGET_WARNING);
        await expect(card).not.toContainText(PACE_WARNING);
        await expect(card).not.toContainText('Dentro do plano');
        await expect(card).toContainText(/Restam|Acima/);
        await expect(card.getByRole('meter')).toBeVisible();
        await expect(card).toContainText(`Hoje: dia ${cal.dayOfMonth} de ${cal.daysInMonth}`);
        await expect(card).toContainText(/\d+% do previsto gasto em \d+% do mês/);
        await expect(hero().getByRole('link', { name: 'Ver orçamento' })).toBeVisible();
        // The lines that need a look, by name.
        const attention = page.getByTestId('home-attention-lines');
        await expect(attention).toContainText('Supermercado');
        await expect(attention.getByRole('link').first()).toHaveAttribute(
          'href',
          /^\/budget\?month=\d{4}-\d{2}#line-/,
        );

        // Review prompt, from the real count.
        if (waiting > 0) {
          const review = page.getByTestId('home-review');
          await expect(review).toContainText(
            waiting === 1 ? '1 movimento por rever' : `${waiting} movimentos por rever`,
          );
          await expect(review.getByRole('link', { name: 'Rever' })).toHaveAttribute(
            'href',
            '/transactions/review',
          );
        } else {
          await expect(page.getByTestId('home-review')).toHaveCount(0);
        }

        // Next seven days: the three euro payments in date order, the dollar one counted apart.
        const block = upcoming();
        await expect(page.getByRole('region', { name: 'Próximos pagamentos' })).toBeVisible();
        await expect(block.getByRole('listitem')).toHaveCount(4);
        const rows = block.getByRole('listitem');
        await expect(rows.nth(0)).toContainText('Hoje');
        await expect(rows.nth(0)).toContainText('P5 Ginásio');
        await expect(rows.nth(0)).toContainText(`−${eur(2990)}`);
        await expect(rows.nth(1)).toContainText('Amanhã');
        await expect(rows.nth(1)).toContainText('P5 Seguro');
        await expect(rows.nth(2)).toContainText('P5 Software');
        await expect(rows.nth(3)).toContainText('P5 Streaming');
        for (const out of ['P5 Longe', 'P5 Salário', 'P5 Talvez']) {
          await expect(block).not.toContainText(out);
        }
        await expect(block).toContainText(`Total previsto: −${eur(2990 + 5407 + 1299)}`);
        await expect(block).toContainText('1 noutra moeda');
        await expect(block.getByRole('link', { name: 'Ver subscrições' })).toHaveAttribute(
          'href',
          '/budget/subscriptions',
        );

        // Net worth: the same figure as Resumo, and a sparkline of the stored months.
        const nw = page.getByRole('region', { name: 'Património' });
        await expect(nw).toBeVisible();
        const headline = (await nw.getByTestId('home-net-worth').textContent()) ?? '';
        const spark = nw.getByTestId('home-net-worth-sparkline');
        await expect(spark).toBeVisible();
        await expect(spark.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        await expect(spark.locator('svg polyline:not([stroke-dasharray])')).toHaveCount(1);
        await expect(spark.locator('svg polyline[stroke-dasharray]')).toHaveCount(1);
        // Six months of history: "Desde …", from the first stored month to the live net worth.
        await expect(spark.locator('figcaption')).toContainText(`de ${eur(800_000)} para`);
        await expect(spark.locator('figcaption')).toContainText('Desde');
        const frame = await spark.locator('svg').boundingBox();
        const cardBox = await nw.getByTestId('home-net-worth').boundingBox();
        expect(frame!.width, 'the sparkline fills the card').toBeGreaterThan(200);
        expect(frame!.x).toBeGreaterThanOrEqual(cardBox!.x - 1);

        // Accounts and connections: balance and freshness in one block.
        const accounts = page.getByRole('region', { name: 'Contas e ligações' });
        await expect(accounts.getByText('Saldo disponível')).toBeVisible();
        await expect(accounts.getByRole('link', { name: 'Ver contas' })).toHaveAttribute(
          'href',
          '/accounts',
        );
        if (connections > 0) {
          await expect(accounts.getByRole('link', { name: /^Estado das ligações:/ })).toBeVisible();
        } else {
          await expect(
            accounts.getByText('Contas atualizadas por importação ou à mão.'),
          ).toBeVisible();
        }

        // What the dashboard replaced is gone.
        await expect(page.getByRole('heading', { name: 'Últimos movimentos' })).toHaveCount(0);
        await expect(
          page.getByRole('heading', { name: 'Contas', level: 2, exact: true }),
        ).toHaveCount(0);
        await expect(page.getByText(/^Olá, /)).toHaveCount(0);
        await shoot(page, 'A1-home-ready');

        await page.goto('/budget');
        await expect(page.getByText(BUDGET_WARNING)).toBeVisible();
        await expect(page.getByText('Dentro do plano')).toHaveCount(0);

        // The net worth figure is the one Resumo shows.
        await page.goto('/net-worth');
        const figure = (text: string) => text.replace(/[^\d,−-]/g, '');
        expect(figure((await page.getByTestId('net-worth-total').textContent()) ?? '')).toBe(
          figure(headline),
        );
      }),
    );
  });

  test('next payments: the week, the overflow row, and what to say with nothing due', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const many: RecurringSeed[] = Array.from({ length: 7 }, (_, i) => ({
      name: `P5 Pagamento ${i + 1}`,
      amount: -1000 - i,
      on: cal.day(i % 7),
    }));

    // Seven due: five rows and a link for the other two; the total still counts all seven.
    await withRecurring(many, async () => {
      await page.goto('/');
      await expect(upcoming().getByRole('listitem')).toHaveCount(6);
      const more = upcoming().getByRole('link', { name: 'Mais 2 pagamentos' });
      await expect(more).toHaveAttribute('href', '/budget/subscriptions');
      const total = [0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + 1000 + i, 0);
      await expect(upcoming()).toContainText(`Total previsto: −${eur(total)}`);
    });

    // Confirmed payments exist, none due this week.
    await withRecurring([{ name: 'P5 Mais tarde', amount: -4000, on: cal.day(20) }], async () => {
      await page.goto('/');
      await expect(
        upcoming().getByText('Sem pagamentos recorrentes previstos nos próximos 7 dias.'),
      ).toBeVisible();
      await expect(upcoming().getByRole('listitem')).toHaveCount(0);
      await shoot(page, 'A2-home-upcoming-empty');
    });

    // Only detections: ask to confirm them.
    await withRecurring(
      [
        { name: 'P5 Detetado 1', amount: -1500, on: cal.day(1), status: 'detected' },
        { name: 'P5 Detetado 2', amount: -2500, on: cal.day(2), status: 'detected' },
      ],
      async () => {
        await page.goto('/');
        await expect(upcoming()).toContainText('2 pagamentos recorrentes detetados por confirmar.');
        await expect(upcoming().getByRole('link', { name: 'Confirmar' })).toHaveAttribute(
          'href',
          '/budget/subscriptions',
        );
        await shoot(page, 'A3-home-upcoming-confirm');
      },
    );

    // A household with no recurring items does not get an empty widget.
    await withRecurring([], async () => {
      await page.goto('/');
      await expect(hero()).toBeVisible();
      await expect(page.getByTestId('home-upcoming')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Próximos pagamentos' })).toHaveCount(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Empty states

  test('with no budget the hero still shows the month and offers to create one', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await withoutBudgets(() =>
      withSnapshots([], () =>
        withRecurring([], async () => {
          await page.goto('/');
          const month = page.getByRole('region', { name: 'Este mês' });
          await expect(month).toBeVisible();
          await expect(page.getByRole('region', { name: /^Orçamento de/ })).toHaveCount(0);
          await expect(month.getByText('Ainda não há orçamento para este mês.')).toBeVisible();
          await expect(month.getByText('Saídas este mês')).toBeVisible();
          await expect(month).toContainText(
            'Sem transferências entre contas nem movimentos pendentes.',
          );
          await expect(month.getByRole('link', { name: 'Criar orçamento' })).toHaveAttribute(
            'href',
            '/budget/new',
          );

          // Nothing to draw yet: the figure stays, the sparkline and the payments block do not.
          const nw = page.getByRole('region', { name: 'Património' });
          await expect(nw.getByTestId('home-net-worth')).toBeVisible();
          await expect(page.getByTestId('home-net-worth-sparkline')).toHaveCount(0);
          await expect(page.getByTestId('home-upcoming')).toHaveCount(0);
          await shoot(page, 'A4-home-no-budget');
        }),
      ),
    );
  });

  // -------------------------------------------------------------------------------------------
  // One block failing

  test('a block that fails shows its own error and leaves the rest of the page standing', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Another tab: the failed query is also logged by the server, and this keeps the suite's
    // console watch to the pages that should render cleanly.
    const failing = await page.context().newPage();
    try {
      await withRecurring(week(), async () => {
        await withoutTable('recurring', async () => {
          await failing.goto('/');
          const block = failing.getByRole('region', { name: 'Próximos pagamentos' });
          await expect(
            block.getByText('Não foi possível carregar os próximos pagamentos.'),
          ).toBeVisible();
          await expect(block.getByRole('link', { name: 'Tentar novamente' })).toHaveAttribute(
            'href',
            '/',
          );
          // Everything else is there.
          await expect(failing.getByTestId('home-budget-hero')).toBeVisible();
          await expect(failing.getByRole('region', { name: 'Património' })).toBeVisible();
          await expect(failing.getByRole('region', { name: 'Contas e ligações' })).toBeVisible();
          await expect(failing.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();
          await shoot(failing, 'A5-home-upcoming-error');
        });
        // It recovers on its own once the data is back.
        await failing.reload();
        await expect(failing.getByTestId('home-upcoming')).toContainText('P5 Ginásio');
      });

      // The same for net worth: its frame keeps the title, the other blocks do not notice.
      await withoutTable('net_worth_snapshot', async () => {
        await failing.goto('/');
        const nw = failing.getByRole('region', { name: 'Património' });
        await expect(nw.getByText('Não foi possível calcular o património.')).toBeVisible();
        await expect(failing.getByTestId('home-budget-hero')).toBeVisible();
        await expect(failing.getByRole('region', { name: 'Contas e ligações' })).toBeVisible();
        await expect(failing.getByTestId('home-upcoming')).toBeVisible();
      });
    } finally {
      await failing.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  // A viewer reads everything and changes nothing

  test('a viewer sees every block, with no way to create or confirm anything', async () => {
    const waiting = (
      await sql<{ n: number }>('select count(*)::int as n from transaction where needs_review')
    )[0]!.n;
    const ctx = await newOwnerContext(browser);
    const guest = await ctx.newPage();
    const guestProblems: string[] = [];
    watch(guest, guestProblems);
    try {
      await guest.goto('/sign-in');
      await guest.getByLabel('Email').fill(VIEWER.email);
      await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
      await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(guest).toHaveURL(/\/$/);

      await withRecurring(week(), async () => {
        await guest.goto('/');
        await expect(guest.getByTestId('home-budget-hero')).toBeVisible();
        await expect(guest.getByTestId('home-upcoming')).toContainText('P5 Ginásio');
        await expect(guest.getByRole('region', { name: 'Património' })).toBeVisible();
        await expect(guest.getByRole('region', { name: 'Contas e ligações' })).toBeVisible();
        await expect(guest.getByRole('link', { name: 'Criar orçamento' })).toHaveCount(0);
        // Reviewing is a write flow: the count is there, the action is not.
        if (waiting > 0) {
          await expect(guest.getByTestId('home-review')).toContainText('por rever');
          await expect(
            guest.getByTestId('home-review').getByRole('link', { name: 'Rever', exact: true }),
          ).toHaveCount(0);
        }
        await shoot(guest, 'A6-home-viewer');
      });

      // No budget: the figure and a hint instead of the button.
      await withoutBudgets(() =>
        withRecurring(
          [{ name: 'P5 Detetado', amount: -1500, on: cal.day(1), status: 'detected' }],
          async () => {
            await guest.goto('/');
            const month = guest.getByRole('region', { name: 'Este mês' });
            await expect(month.getByText('Saídas este mês')).toBeVisible();
            await expect(
              month.getByText('Um membro do agregado pode criar o orçamento.'),
            ).toBeVisible();
            await expect(guest.getByRole('link', { name: 'Criar orçamento' })).toHaveCount(0);

            // Detections to confirm: the sentence, not the link.
            await expect(guest.getByTestId('home-upcoming')).toContainText(
              '1 pagamento recorrente detetado por confirmar.',
            );
            await expect(guest.getByRole('link', { name: 'Confirmar' })).toHaveCount(0);
          },
        ),
      );
      expect(guestProblems).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  // Accessibility, light and dark. Three tests: each screen group has its own budget on a slow
  // runner.

  test('axe finds no serious or critical violations on the home with data', async () => {
    await withSnapshots(history(), () =>
      withRecurring(week(), async () => {
        for (const size of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(size);
          await page.goto('/');
          await expect(page.getByTestId('home-net-worth-sparkline')).toBeVisible();
          await expect(upcoming().getByRole('listitem').first()).toBeVisible();
          await expectAccessible(page);
        }
      }),
    );
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('axe finds no serious or critical violations on the home without a budget and with the other upcoming states', async () => {
    await withoutBudgets(async () => {
      for (const [seed, shown] of [
        [[] as RecurringSeed[], null],
        [
          [{ name: 'P5 Detetado', amount: -1500, on: cal.day(1), status: 'detected' as const }],
          'detetado por confirmar',
        ],
        [[{ name: 'P5 Mais tarde', amount: -4000, on: cal.day(20) }], 'Sem pagamentos recorrentes'],
      ] as const) {
        await withRecurring([...seed], async () => {
          for (const size of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(size);
            await page.goto('/');
            await expect(page.getByRole('region', { name: 'Este mês' })).toBeVisible();
            if (shown) await expect(upcoming()).toContainText(shown);
            await expectAccessible(page);
          }
        });
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('axe finds no serious or critical violations on the home with blocks that failed', async () => {
    const failing = await page.context().newPage();
    try {
      await withRecurring(week(), async () => {
        await withoutTable('recurring', async () => {
          await withoutTable('net_worth_snapshot', async () => {
            for (const size of [
              { width: 1280, height: 800 },
              { width: 390, height: 844 },
            ]) {
              await failing.setViewportSize(size);
              await failing.goto('/');
              await expect(
                failing.getByText('Não foi possível carregar os próximos pagamentos.'),
              ).toBeVisible();
              await expect(
                failing.getByText('Não foi possível calcular o património.'),
              ).toBeVisible();
              await expectAccessible(failing);
            }
          });
        });
      });
    } finally {
      await failing.close();
    }
  });

  // -------------------------------------------------------------------------------------------
  // 320px

  test('the home fits a 320px phone without sideways scrolling, in every state', async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const long: RecurringSeed[] = [
      {
        name: 'P5 Prestação do automóvel com um nome tão comprido que não cabe numa só linha',
        amount: -123456,
        on: cal.day(1),
      },
      { name: 'P5 Seguro', amount: -5407, on: cal.day(0) },
      { name: 'P5 Dólares', amount: -999999, on: cal.day(2), currency: 'USD' },
    ];

    // Data: hero, review, payments, net worth with its sparkline, accounts.
    await withSnapshots(history(), () =>
      withRecurring(long, async () => {
        await page.goto('/');
        await expect(page.getByTestId('home-net-worth-sparkline')).toBeVisible();
        await expect(upcoming()).toContainText('P5 Prestação do automóvel');
        await expectNoOverflow(page);
        await snap(page, 'A7-home-320');
        // The sparkline shrinks with its card instead of keeping a pixel width.
        const card = await page.getByTestId('home-net-worth').boundingBox();
        const svg = await page.getByTestId('home-net-worth-sparkline').locator('svg').boundingBox();
        expect(svg!.width).toBeLessThanOrEqual(320 - 2 * 16 - 2 * 16 + 1);
        expect(svg!.x + svg!.width).toBeLessThanOrEqual(320 - 16);
        expect(card!.x).toBeGreaterThanOrEqual(0);
      }),
    );

    // No budget, nothing else.
    await withoutBudgets(() =>
      withRecurring([], async () => {
        await page.goto('/');
        await expect(page.getByRole('region', { name: 'Este mês' })).toBeVisible();
        await expectNoOverflow(page);
        await snap(page, 'A8-home-no-budget-320');
      }),
    );

    // Failed blocks.
    const failing = await page.context().newPage();
    try {
      await failing.setViewportSize({ width: 320, height: 640 });
      await withoutTable('recurring', async () => {
        await failing.goto('/');
        await expect(
          failing.getByText('Não foi possível carregar os próximos pagamentos.'),
        ).toBeVisible();
        await expectNoOverflow(failing);
      });
    } finally {
      await failing.close();
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('skeletons stay invisible for the first 200ms, then fade in', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    // The same class the block skeletons use: probe it in the page, where the stylesheet is.
    const opacity = await page.evaluate(async () => {
      const probe = document.createElement('div');
      probe.className = 'skeleton h-16 w-full';
      document.querySelector('main')!.append(probe);
      const first = getComputedStyle(probe).opacity;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const later = getComputedStyle(probe).opacity;
      probe.remove();
      return { first, later };
    });
    expect(opacity.first).toBe('0');
    expect(opacity.later).toBe('1');
  });

  // -------------------------------------------------------------------------------------------
  // Análises

  test.describe('insights', () => {
    const spending = () => page.getByTestId('insights-spending');
    const cashFlow = () => page.getByTestId('insights-cashflow');
    const trends = () => page.getByTestId('insights-trends');
    const groups = () => spending().getByTestId('spending-group');

    /**
     * Opens a page of Análises and picks chart or table. The choice lives in `localStorage`, so
     * it is set explicitly (and announced the way the page's own button does) rather than left
     * to whatever an earlier test chose.
     */
    async function visit(path: string, view: 'chart' | 'table' = 'chart') {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Análises', level: 1 })).toBeVisible();
      await page.evaluate((v) => {
        window.localStorage.setItem('insights-view', v);
        window.dispatchEvent(new Event('insights-view-change'));
      }, view);
    }

    /** Opens Análises on the seeded window (`end` = its last month). */
    async function open(data: InsightsData, query = '', view: 'chart' | 'table' = 'chart') {
      await visit(`/insights?end=${data.endParam}${query}`, view);
      await expect(spending()).toBeVisible();
    }

    test.afterEach(async () => {
      await page.evaluate(() => window.localStorage.setItem('insights-view', 'chart'));
    });

    test.beforeEach(async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    test('spending by group: ranked bars, groups that open into categories, and a table that agrees', async () => {
      await withInsightsData(cal, async (d) => {
        await open(d);
        await expect(page.getByText('Só movimentos contabilizados.')).toBeVisible();

        // Total, then the groups from biggest to smallest, "Sem categoria" always last.
        await expect(spending()).toContainText(new RegExp(money(89500)));
        await expect(spending()).toContainText('Total em');
        await expect(groups()).toHaveCount(3);
        await expect(groups().nth(0)).toContainText('P5 Casa');
        await expect(groups().nth(0)).toContainText(new RegExp(money(86000)));
        await expect(groups().nth(0)).toContainText('96%');
        await expect(groups().nth(1)).toContainText('P5 Lazer');
        await expect(groups().nth(1)).toContainText(new RegExp(money(2000)));
        await expect(groups().nth(2)).toContainText('Sem categoria');
        await expect(groups().nth(2)).toContainText(new RegExp(money(1500)));

        // The longest bar is the biggest group, the others are sized against it (not by share).
        const widths = await groups().evaluateAll((rows) =>
          rows.map((row) => {
            const bar = row.querySelector<HTMLElement>('span[style*="width"]');
            return Number.parseFloat(bar?.style.width ?? '0');
          }),
        );
        expect(widths[0]).toBe(100);
        expect(widths[1]).toBeCloseTo((2000 / 86000) * 100, 1);
        expect(widths[2]).toBeCloseTo((1500 / 86000) * 100, 1);

        // The dollar row is counted and left out.
        await expect(spending()).toContainText(
          '1 movimento noutra moeda ficou fora destes valores.',
        );

        // Groups open into categories; collapsed categories cannot be reached.
        const casa = groups()
          .nth(0)
          .getByRole('button', { name: /P5 Casa/ });
        await expect(casa).toHaveAttribute('aria-expanded', 'false');
        await expect(spending().getByRole('link', { name: /^P5 Renda,/ })).toBeHidden();
        await casa.click();
        await expect(casa).toHaveAttribute('aria-expanded', 'true');
        const renda = spending().getByRole('link', {
          name: new RegExp(`^P5 Renda, ${money(80000)}, ver movimentos$`),
        });
        await expect(renda).toBeVisible();
        await expect(spending().getByRole('link', { name: /^P5 Luz,/ })).toBeVisible();
        const href = (await renda.getAttribute('href')) ?? '';
        const params = new URL(href, 'http://x').searchParams;
        expect(params.get('period')).toBe('custom');
        expect(params.get('from')).toBe(d.m.e);
        expect(params.get('to')).toBe(d.lastDay(d.m.e));
        expect(params.getAll('category')).toEqual([d.ids.renda]);
        expect(params.get('status')).toBe('booked');
        expect(params.get('transfers')).toBe('exclude');
        expect(params.get('type')).toBeNull();
        const groupLink = spending().getByRole('link', { name: 'Ver movimentos de P5 Casa' });
        expect(
          new URL((await groupLink.getAttribute('href')) ?? '', 'http://x').searchParams.getAll(
            'category',
          ),
        ).toEqual([d.ids.renda, d.ids.luz]);
        // "Sem categoria" links to the outflows without a category.
        const uncategorised = new URL(
          (await groups().nth(2).getByRole('link').getAttribute('href')) ?? '',
          'http://x',
        ).searchParams;
        expect(uncategorised.get('uncategorised')).toBe('1');
        expect(uncategorised.get('type')).toBe('out');
        await casa.click();
        await expect(casa).toHaveAttribute('aria-expanded', 'false');
        await casa.click();
        await shoot(page, 'B1-insights-spending', spending());

        // The table has the same figures, and the choice is remembered on this device.
        await page.getByRole('button', { name: 'Ver como tabela' }).first().click();
        const table = page.getByTestId('insights-spending-table');
        await expect(table).toBeVisible();
        await expect(spending().getByTestId('spending-group')).toHaveCount(0);
        await expect(table.getByRole('row', { name: /^P5 Casa/ })).toContainText(
          new RegExp(money(86000)),
        );
        await expect(table.getByRole('row', { name: /^P5 Renda/ })).toContainText('—');
        await expect(table.getByRole('row', { name: /^Sem categoria/ })).toContainText(
          new RegExp(money(1500)),
        );
        await expect(table.getByRole('row', { name: /^Total/ })).toContainText(
          new RegExp(money(89500)),
        );
        await shoot(page, 'B3-insights-tables', spending());
        await page.reload();
        await expect(page.getByTestId('insights-spending-table')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Ver gráfico' }).first()).toBeVisible();
        await page.getByRole('button', { name: 'Ver gráfico' }).first().click();
        await expect(page.getByTestId('insights-spending-table')).toHaveCount(0);
      });
    });

    test('a transfer between the household accounts is in no total', async () => {
      await withInsightsData(cal, async (d) => {
        await open(d);
        // 500,00 moved from the checking to the savings account: neither spending nor flow.
        await expect(spending()).toContainText(new RegExp(money(89500)));
        await expect(spending()).not.toContainText(new RegExp(money(139500)));
        await expect(cashFlow().getByTestId('cashflow-out')).toContainText(
          new RegExp(`−${money(90000)}`),
        );
        await expect(cashFlow().getByTestId('cashflow-in')).toContainText(
          new RegExp(`\\+${money(200800)}`),
        );
        await expect(cashFlow().getByTestId('cashflow-net')).toContainText(
          new RegExp(money(110800)),
        );
        // The savings account only received the transfer: nothing to show for it.
        await expect(cashFlow().getByTestId('cashflow-account-row')).toHaveCount(1);
        await page.getByRole('button', { name: 'Ver como tabela' }).first().click();
        await expect(page.getByTestId('insights-spending-table')).not.toContainText('Transfer');
        // Trends: income of the salary and the uncategorised inflow (the cinema refund nets out).
        await expect(page.getByTestId('insights-trends-table')).toContainText(
          new RegExp(money(200300)),
        );
        await expect(page.getByTestId('insights-trends-table')).not.toContainText(
          new RegExp(money(250800)),
        );
      });
    });

    test('the list behind each figure adds up to it: booked rows only, no transfers', async () => {
      await withInsightsData(cal, async (d) => {
        const dayTotal = (date: string) => page.locator(`#day-${date}`);
        const rowButton = (text: string | RegExp) => page.getByRole('button', { name: text });

        // A category group: both rows, the pending bill and the other group are not listed.
        await open(d);
        await groups()
          .nth(0)
          .getByRole('button', { name: /P5 Casa/ })
          .click();
        await spending().getByRole('link', { name: 'Ver movimentos de P5 Casa' }).click();
        await expect(page).toHaveURL(/\/transactions\?/);
        await expect(page.getByRole('button', { name: 'Só contabilizados' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(page.getByRole('button', { name: 'Sem transferências' })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(rowButton(/P5 Renda/)).toBeVisible();
        await expect(rowButton(/P5 Luz/)).toHaveCount(1);
        await expect(rowButton(/P5 Luz pendente/)).toHaveCount(0);
        await expect(rowButton(/P5 Cinema/)).toHaveCount(0);
        // The day's total is the chart's figure for the group.
        await expect(dayTotal(d.on(d.m.e, 5))).toContainText(new RegExp(`−${money(86000)}`));
        // Without the booked filter the pending bill shows up (the total stays the same).
        await page.getByRole('button', { name: 'Só contabilizados' }).click();
        await expect(page).not.toHaveURL(/status=booked/);
        await expect(rowButton(/P5 Luz pendente/)).toBeVisible();
        await expect(dayTotal(d.on(d.m.e, 5))).toContainText(new RegExp(`−${money(86000)}`));

        // Uncategorised: only the outflow, as the chart counts it.
        await open(d);
        await groups().nth(2).getByRole('link').click();
        await expect(rowButton(/P5 Sem categoria/)).toBeVisible();
        await expect(rowButton(/P5 Devolução/)).toHaveCount(0);
        await expect(dayTotal(d.on(d.m.e, 9))).toContainText(new RegExp(`−${money(1500)}`));

        // An account: the days add up to its net in the cash flow section, and the transfer is out.
        await open(d);
        const account = cashFlow().getByTestId('cashflow-account-row');
        await expect(account).toHaveAttribute('data-account-id', d.ids.accountA);
        await account.click();
        await expect(rowButton(/P5 Salário/)).toBeVisible();
        await expect(rowButton(/P5 Transferência/)).toHaveCount(0);
        await expect(rowButton(/P5 Luz pendente/)).toHaveCount(0);
        // Each day heading ends with that day's total.
        const totals = await page.locator('h3[id^="day-"] > span:last-child').allTextContents();
        const sum = totals.reduce((acc, text) => acc + centsOf(text), 0);
        expect(sum).toBe(200800 - 90000);
        // Without the transfer filter the two legs of the move are listed.
        await page.getByRole('button', { name: 'Sem transferências' }).click();
        await expect(rowButton(/P5 Transferência saída/)).toBeVisible();
      });
    });

    test('period controls: month, 3 and 12 months and the stepper are links, and Back walks through them', async () => {
      await withInsightsData(cal, async (d) => {
        // The current month first: "em curso", and no way past it.
        await visit('/insights');
        const period = page.getByRole('navigation', { name: 'Período' });
        await expect(period.getByRole('link', { name: 'Mês', exact: true })).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(page.getByText('em curso', { exact: true })).toBeVisible();
        await expect(page.getByRole('link', { name: /^Mês seguinte/ })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Este mês' })).toHaveCount(0);
        await expect(cashFlow().getByText('Por mês', { exact: true })).toHaveCount(0);

        await period.getByRole('link', { name: '3 meses' }).click();
        await expect(page).toHaveURL(/[?&]range=3/);
        await expect(period.getByRole('link', { name: '3 meses' })).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(page.getByTestId('period-label')).toHaveText(/^\S+–\S+ \d{4}$/);
        await expect(cashFlow().getByText('Por mês', { exact: true })).toBeVisible();

        await page.getByRole('link', { name: /^Mês anterior/ }).click();
        await expect(page).toHaveURL(/range=3&end=\d{4}-\d{2}/);
        await expect(page.getByText('em curso', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Este mês' })).toBeVisible();
        const steppedUrl = page.url();

        await page.getByRole('link', { name: 'Este mês' }).click();
        await expect(page.getByText('em curso', { exact: true })).toBeVisible();

        // Back retraces every step.
        await page.goBack();
        await expect(page).toHaveURL(steppedUrl);
        await expect(page.getByText('em curso', { exact: true })).toHaveCount(0);
        await page.goBack();
        await expect(page).toHaveURL(/\/insights\?range=3$/);
        await page.goBack();
        await expect(page).toHaveURL(/\/insights$/);
        await expect(period.getByRole('link', { name: 'Mês', exact: true })).toHaveAttribute(
          'aria-current',
          'page',
        );

        // A stale or malformed URL falls back quietly.
        await visit('/insights?range=7&end=nonsense&account=nope');
        await expect(period.getByRole('link', { name: 'Mês', exact: true })).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(page.getByText('em curso', { exact: true })).toBeVisible();
        await visit('/insights?end=2999-01');
        await expect(page.getByText('em curso', { exact: true })).toBeVisible();

        // The three months of the window: the figures of all three, added up.
        await visit(`/insights?range=3&end=${d.endParam}`);
        await expect(spending()).toContainText(new RegExp(money(232500)));
        await expect(spending()).toContainText('Total de');
        await expect(groups().nth(0)).toContainText('P5 Casa');
        await expect(groups().nth(0)).toContainText(new RegExp(money(226000)));
        await expect(groups().nth(1)).toContainText(new RegExp(money(5000)));
        await expect(cashFlow().getByTestId('cashflow-in')).toContainText(
          new RegExp(`\\+${money(581800)}`),
        );
        await expect(cashFlow().getByTestId('cashflow-out')).toContainText(
          new RegExp(`−${money(233000)}`),
        );
        await expect(cashFlow().getByTestId('cashflow-net')).toContainText(
          new RegExp(money(348800)),
        );
        // The links of a longer period span all of it.
        await groups()
          .nth(0)
          .getByRole('button', { name: /P5 Casa/ })
          .click();
        const href = await spending()
          .getByRole('link', { name: 'Ver movimentos de P5 Casa' })
          .getAttribute('href');
        const link = new URL(href ?? '', 'http://x').searchParams;
        expect(link.get('from')).toBe(d.m.e2);
        expect(link.get('to')).toBe(d.lastDay(d.m.e));

        // The 12 months of the window still show the same trends, and the period is marked.
        await visit(`/insights?range=12&end=${d.endParam}`);
        await expect(page.getByRole('navigation', { name: 'Período' })).toBeVisible();
        await expect(trends().getByText('Período selecionado')).toBeVisible();
      });
    });

    test('trends: two panels on one month axis, a slider that reads each month, and a table that agrees', async () => {
      await withInsightsData(cal, async (d) => {
        await open(d, '&range=3');
        const chart = page.getByTestId('insights-trends-chart');
        await expect(chart).toBeVisible();
        await expect(trends().getByRole('heading', { name: 'Evolução em 12 meses' })).toBeVisible();
        await expect(chart.locator('svg.absolute')).toHaveAttribute('aria-hidden', 'true');
        await expect(chart.locator('figcaption')).toContainText('Poupança total');
        await expect(chart.getByText('Entradas e saídas')).toBeVisible();
        await expect(chart.getByText('Poupança por mês')).toBeVisible();
        await expect(trends()).toContainText('Sem rubricas de poupança no orçamento');
        await expect(chart.getByText('Período selecionado')).toBeVisible();
        // The leading empty months are not drawn: six months, from the first salary.
        const slider = chart.getByRole('slider', { name: 'Mês no gráfico de evolução' });
        await expect(slider).toHaveAttribute('aria-valuemax', '5');
        await expect(slider).toHaveAttribute('aria-valuenow', '5');
        await expect(slider).toHaveAttribute(
          'aria-valuetext',
          new RegExp(`entradas \\+${money(200300)}, saídas −${money(89500)}`),
        );
        const readout = page.getByTestId('trends-readout');
        await expect(readout).toContainText(new RegExp(`Entradas \\+${money(200300)}`));
        // Income and spending are two lines; no budget saving lines, so no saving columns.
        await expect(chart.locator('svg polyline')).toHaveCount(2);

        // Keyboard: arrows, Home and End move the reading month by month.
        await slider.focus();
        await page.keyboard.press('ArrowLeft');
        await expect(slider).toHaveAttribute('aria-valuenow', '4');
        await expect(slider).toHaveAttribute(
          'aria-valuetext',
          new RegExp(`entradas \\+${money(191000)}, saídas −${money(70000)}`),
        );
        await page.keyboard.press('Home');
        await expect(slider).toHaveAttribute('aria-valuenow', '0');
        await expect(slider).toHaveAttribute(
          'aria-valuetext',
          new RegExp(`entradas \\+${money(100000)}`),
        );
        await expect(chart.getByRole('button', { name: 'Mais recente' })).toBeVisible();
        await page.keyboard.press('End');
        await expect(slider).toHaveAttribute('aria-valuenow', '5');
        await expect(chart.getByRole('button', { name: 'Mais recente' })).toHaveCount(0);
        await shoot(page, 'B2-insights-trends', trends());

        // The table: every month, newest first, the period's months marked; zeros are real zeros.
        await page.getByRole('button', { name: 'Ver como tabela' }).first().click();
        const table = page.getByTestId('insights-trends-table');
        await expect(table).toBeVisible();
        const body = table.locator('tbody tr');
        await expect(body).toHaveCount(6);
        await expect(body.nth(0)).toHaveAttribute('data-month', d.endParam);
        await expect(body.nth(0)).toContainText(new RegExp(`\\+${money(200300)}`));
        await expect(body.nth(0)).toContainText(new RegExp(`−${money(89500)}`));
        await expect(body.nth(0)).toContainText(new RegExp(money(110800)));
        await expect(body.nth(0)).toContainText('período selecionado');
        await expect(body.nth(1)).toContainText(new RegExp(`\\+${money(191000)}`));
        await expect(body.nth(2)).toContainText(new RegExp(`−${money(73000)}`));
        await expect(body.nth(2)).toContainText(new RegExp(money(117000)));
        await expect(body.nth(3)).toContainText(new RegExp(money(0)));
        await expect(body.nth(3)).not.toContainText('período selecionado');
        await expect(body.nth(5)).toContainText(new RegExp(`\\+${money(100000)}`));
        // The same oracle the service uses, computed straight from the rows: expense is the net
        // outflow of expense-kind categories (a category never below zero) plus uncategorised
        // outflows; income is income-kind net plus uncategorised inflows.
        const oracle = await sql<{ month: string; income: string; expense: string }>(
          `select month,
                  (coalesce(sum(greatest(net, 0)) filter (where kind = 'income'), 0)
                    + coalesce(sum(ins) filter (where category_id is null), 0))::text as income,
                  (coalesce(sum(greatest(-net, 0)) filter (where kind = 'expense'), 0)
                    + coalesce(sum(-outs) filter (where category_id is null), 0))::text as expense
             from (
               select to_char(t.booking_date, 'YYYY-MM') as month, t.category_id, g.kind,
                      sum(t.amount) as net,
                      sum(t.amount) filter (where t.amount < 0) as outs,
                      sum(t.amount) filter (where t.amount > 0) as ins
                 from transaction t
                 left join category c on c.id = t.category_id
                 left join category_group g on g.id = c.group_id
                where t.status = 'booked' and t.currency = 'EUR' and t.transfer_group_id is null
                  and (t.category_id is null or t.category_id not in
                        (select id from category where template_key = 'transfer.between_accounts'))
                  and t.booking_date between $1 and $2
                group by 1, 2, 3
             ) per
            group by month order by month desc`,
          [d.m.e5, d.lastDay(d.m.e)],
        );
        expect(oracle.map((o) => [o.month, Number(o.income), Number(o.expense)])).toEqual([
          [d.endParam, 200300, 89500],
          [d.m.e1.slice(0, 7), 191000, 70000],
          [d.m.e2.slice(0, 7), 190000, 73000],
          [d.m.e5.slice(0, 7), 100000, 0],
        ]);
      });
    });

    test('trends: nothing to draw, or a single month, says so', async () => {
      await withInsightsData(cal, async (d) => {
        // Twelve months with no data at all.
        await visit(`/insights?end=${cal.month(-60).slice(0, 7)}`);
        await expect(trends()).toContainText('Sem movimentos contabilizados nestes 12 meses.');
        await expect(trends().getByRole('button', { name: /Ver como tabela/ })).toHaveCount(0);
        await expect(spending()).toContainText('Sem despesas em');
        await expect(spending().getByRole('link', { name: 'Ver movimentos' })).toHaveAttribute(
          'href',
          /status=booked/,
        );
        await expect(cashFlow()).toContainText('Sem entradas nem saídas neste período.');
        await expect(spending().getByTestId('spending-group')).toHaveCount(0);
        await shoot(page, 'B5-insights-empty', spending());

        // Only the first salary: a single month is not a chart.
        await visit(`/insights?end=${d.m.e5.slice(0, 7)}`);
        await expect(trends()).toContainText('Os dados começam em');
        await expect(trends()).toContainText('O gráfico aparece quando houver dois meses.');
        await expect(trends().getByRole('slider')).toHaveCount(0);
        await page.evaluate(() => window.localStorage.setItem('insights-view', 'table'));
        await page.reload();
        await expect(page.getByTestId('insights-trends-table').locator('tbody tr')).toHaveCount(1);
        await page.evaluate(() => window.localStorage.setItem('insights-view', 'chart'));
      });
    });

    test('cash flow: filter by account, net per month, and an account row that links to its movements', async () => {
      await withInsightsData(cal, async (d) => {
        await open(d, '&range=3');
        // Net per month: one column per month, a slider that reads each.
        const slider = cashFlow().getByRole('slider', {
          name: 'Mês no gráfico de fluxo de caixa',
        });
        await expect(slider).toHaveAttribute('aria-valuemax', '2');
        await expect(slider).toHaveAttribute(
          'aria-valuetext',
          new RegExp(
            `Entrou \\+${money(200800)} · Saiu −${money(90000)} · Saldo \\+${money(110800)}`,
          ),
        );
        await slider.focus();
        await page.keyboard.press('ArrowLeft');
        await expect(slider).toHaveAttribute('aria-valuenow', '1');
        await expect(page.getByTestId('cashflow-readout')).toContainText(
          new RegExp(`Entrou \\+${money(191000)}`),
        );
        await expect(cashFlow().locator('figure svg rect')).toHaveCount(3);

        // Accounts: the checking account first (biggest outflow), then the savings account.
        const rows = cashFlow().getByTestId('cashflow-account-row');
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0)).toHaveAttribute('data-account-id', d.ids.accountA);
        await expect(rows.nth(0)).toHaveAccessibleName(
          new RegExp(
            `^P5 Corrente: entrou ${money(580800)}, saiu ${money(233000)}, ver movimentos$`,
          ),
        );
        await expect(rows.nth(1)).toContainText('P5 Poupança');
        // A savings account with nothing going out shows a plain zero, never a negative one.
        await expect(rows.nth(1)).toContainText('0,00');
        await expect(rows.nth(1)).not.toContainText('−0,00');
        await expect(cashFlow()).toContainText(/conta(s)? sem movimentos neste período/);
        await expect(cashFlow()).toContainText('Contas noutra moeda não entram nestes valores.');
        await shoot(page, 'B4-insights-cashflow-3m', cashFlow());

        // The filter: one account, so no per-account list; Back restores "all accounts".
        const select = cashFlow().getByRole('combobox', { name: 'Conta' });
        await expect(select).toHaveValue('');
        await select.selectOption({ label: 'P5 Poupança' });
        await expect(page).toHaveURL(new RegExp(`account=${d.ids.accountB}`));
        await expect(cashFlow().getByTestId('cashflow-in')).toContainText(new RegExp(money(1000)));
        await expect(cashFlow().getByTestId('cashflow-out')).toContainText('0,00');
        await expect(cashFlow().getByTestId('cashflow-account-row')).toHaveCount(0);
        await expect(select).toHaveValue(d.ids.accountB);
        // Back to all accounts keeps the rest of the period.
        await select.selectOption({ label: 'Todas as contas' });
        await expect(page).not.toHaveURL(/account=/);
        await expect(page).toHaveURL(/range=3/);
        await expect(cashFlow().getByTestId('cashflow-account-row')).toHaveCount(2);

        // The table view lists the months and the accounts, with a total.
        await page.getByRole('button', { name: 'Ver como tabela' }).first().click();
        const table = cashFlow().getByTestId('insights-cashflow-table');
        await expect(
          table.getByTestId('cashflow-account-table').getByRole('row', { name: /^Total/ }),
        ).toContainText(new RegExp(money(581800)));
        await expect(table.getByTestId('cashflow-month-table').locator('tbody tr')).toHaveCount(3);
        await expect(
          table.getByTestId('cashflow-month-table').locator('tbody tr').nth(0),
        ).toContainText(new RegExp(money(110800)));
        await expect(table.getByTestId('cashflow-account-table').locator('tbody tr')).toHaveCount(
          2,
        );
      });
    });

    test('a section that fails shows its own error and leaves the others standing', async () => {
      const failing = await page.context().newPage();
      try {
        await failing.setViewportSize({ width: 1280, height: 800 });
        // Every section reads the category groups (trends classify income and expense by group
        // kind): each one fails inside its own block while the page and its controls stand.
        await withoutTable('category_group', async () => {
          await failing.goto('/insights');
          await expect(
            failing.getByText('Não foi possível carregar as despesas por grupo.'),
          ).toBeVisible();
          await expect(
            failing.getByText('Não foi possível carregar o fluxo de caixa.'),
          ).toBeVisible();
          await expect(failing.getByTestId('insights-trends')).toContainText(
            'Não foi possível carregar a evolução em 12 meses.',
          );
          await expect(failing.getByRole('heading', { name: 'Análises', level: 1 })).toBeVisible();
          const retry = failing.getByTestId('insights-spending').getByRole('link', {
            name: 'Tentar novamente',
          });
          await expect(retry).toHaveAttribute('href', '/insights');
          await expect(
            failing
              .getByTestId('insights-spending')
              .getByRole('heading', { name: 'Despesas por grupo' }),
          ).toBeVisible();
        });
        // The retry works once the data is back.
        await failing.getByRole('link', { name: 'Tentar novamente' }).first().click();
        await expect(failing.getByTestId('insights-spending').getByRole('heading')).toBeVisible();
        await expect(failing.getByText('Não foi possível carregar')).toHaveCount(0);
      } finally {
        await failing.close();
      }
    });

    test('the sidebar and Mais lead to Análises, after Contas', async () => {
      await visit('/insights');
      const sidebar = page.getByRole('navigation', { name: 'Principal' }).first();
      const names = await sidebar.getByRole('link').allInnerTexts();
      const clean = names.map((n) => n.trim().split('\n')[0]);
      expect(clean.indexOf('Análises')).toBe(clean.indexOf('Contas') + 1);
      await expect(sidebar.getByRole('link', { name: 'Análises' })).toHaveAttribute(
        'aria-current',
        'page',
      );

      // Phones: Mais is the active tab, and Análises is its second row, after Contas e ligações.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page
          .getByRole('navigation', { name: 'Principal' })
          .last()
          .getByRole('link', { name: 'Mais' }),
      ).toHaveAttribute('aria-current', 'page');
      await page.goto('/more');
      const rows = page.getByRole('navigation', { name: 'Mais opções' }).getByRole('link');
      await expect(rows.nth(0)).toContainText('Contas e ligações');
      await expect(rows.nth(1)).toContainText('Análises');
      await expect(rows.nth(1)).toContainText('Para onde vai o dinheiro e como evolui');
      await rows.nth(1).click();
      await expect(page).toHaveURL(/\/insights$/);
      await expect(page.getByRole('heading', { name: 'Análises', level: 1 })).toBeVisible();
    });

    test('a viewer reads every section and has nothing to change', async () => {
      await withInsightsData(cal, async (d) => {
        const ctx = await newOwnerContext(browser);
        const guest = await ctx.newPage();
        const guestProblems: string[] = [];
        watch(guest, guestProblems);
        try {
          await guest.goto('/sign-in');
          await guest.getByLabel('Email').fill(VIEWER.email);
          await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
          await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
          await expect(guest).toHaveURL(/\/$/);
          await expect(guest.getByRole('link', { name: 'Análises' }).first()).toBeVisible();

          await guest.goto(`/insights?range=3&end=${d.endParam}`);
          await expect(guest.getByRole('heading', { name: 'Análises', level: 1 })).toBeVisible();
          await expect(guest.getByTestId('insights-spending')).toContainText(
            new RegExp(money(232500)),
          );
          await expect(guest.getByTestId('insights-cashflow')).toContainText(
            new RegExp(`\\+${money(581800)}`),
          );
          await expect(guest.getByTestId('insights-trends-chart')).toBeVisible();
          await expect(
            guest
              .getByRole('navigation', { name: 'Período' })
              .getByRole('link', { name: '3 meses' }),
          ).toBeVisible();
          // Read-only: no write control anywhere on the page.
          await expect(
            guest
              .getByRole('main')
              .getByRole('button', { name: /^(Adicionar|Criar|Guardar|Apagar|Remover)/ }),
          ).toHaveCount(0);
          // And the lists it links to are open to it.
          await guest.getByTestId('spending-group').first().getByRole('button').click();
          await guest.getByRole('link', { name: /^P5 Renda,/ }).click();
          await expect(guest.getByRole('button', { name: /P5 Renda/ }).first()).toBeVisible();
          await shoot(guest, 'B6-insights-viewer');
          expect(guestProblems).toEqual([]);
        } finally {
          await ctx.close();
        }
      });
    });

    test('negative saving, a deficit month and the live month are drawn', async () => {
      await withInsightsData(cal, (d) =>
        withCaptureExtras(cal, d, async () => {
          await open(d, '&range=12');
          const chart = page.getByTestId('insights-trends-chart');
          const slider = chart.getByRole('slider', { name: 'Mês no gráfico de evolução' });
          await expect(slider).toBeVisible();
          // Rows from the early salary month to the window's last month: the second transfer
          // month (-200,00 saving) is the fourth month (index 3), and its column hangs below zero.
          await slider.focus();
          await page.keyboard.press('Home');
          for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
          await expect(slider).toHaveAttribute(
            'aria-valuetext',
            new RegExp(`poupança −${money(20000)}`),
          );
          await expect(chart.locator('svg.absolute path')).not.toHaveCount(0);
          await expect(trends()).toContainText('Poupança negativa: nesse mês saiu mais');
          await expect(trends()).not.toContainText('Sem rubricas de poupança');
          await expect(chart.locator('figcaption')).toContainText('1 mês com poupança negativa.');
          await shoot(page, 'B10-insights-negative-saving', trends());

          // Net per month: the month with rent and no income is a deficit below the zero line.
          const net = cashFlow().getByRole('slider', { name: 'Mês no gráfico de fluxo de caixa' });
          await net.focus();
          for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
          await expect(page.getByTestId('cashflow-readout')).toContainText(
            new RegExp(`Saldo −${money(70000)}`),
          );
          await shoot(page, 'B11-insights-cashflow-deficit', cashFlow());
          await page.getByRole('button', { name: 'Ver como tabela' }).first().click();
          const row = cashFlow().locator(`tr[data-month="${d.m.e.slice(0, 7)}"]`);
          await expect(row).toBeVisible();

          // The live month: dashed last segment, hollow marker, and the note.
          await visit('/insights?range=3');
          await expect(page.getByTestId('insights-trends-chart')).toBeVisible();
          await expect(trends()).toContainText('O mês corrente ainda está em curso.');
          await expect(trends().locator('svg.absolute polyline[stroke-dasharray]')).not.toHaveCount(
            0,
          );
          await shoot(page, 'B12-insights-live-month', trends());
        }),
      );
    });

    // Axe, in light and dark as separate tests, and split by screen group.
    for (const scheme of ['light', 'dark'] as const) {
      const prepare = async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForFunction(
          (name) => matchMedia(`(prefers-color-scheme: ${name})`).matches,
          scheme,
        );
      };
      const sizes = [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ];

      test(`axe finds no serious or critical violations on Análises with the charts (${scheme})`, async () => {
        await prepare();
        try {
          await withInsightsData(cal, async (d) => {
            for (const size of sizes) {
              await page.setViewportSize(size);
              await open(d, '&range=3');
              await groups()
                .nth(0)
                .getByRole('button', { name: /P5 Casa/ })
                .click();
              await expect(page.getByTestId('insights-trends-chart')).toBeVisible();
              await expect(cashFlow().getByRole('slider')).toBeVisible();
              expect(await axeViolations(page), `axe (${scheme}) ${size.width}px`).toEqual([]);
            }
          });
        } finally {
          await page.emulateMedia({ colorScheme: 'light' });
        }
      });

      test(`axe finds no serious or critical violations on Análises with the tables (${scheme})`, async () => {
        await prepare();
        try {
          await withInsightsData(cal, async (d) => {
            for (const size of sizes) {
              await page.setViewportSize(size);
              await open(d, '&range=3', 'table');
              await expect(page.getByTestId('insights-trends-table')).toBeVisible();
              await expect(cashFlow().getByTestId('insights-cashflow-table')).toBeVisible();
              expect(await axeViolations(page), `axe (${scheme}) ${size.width}px`).toEqual([]);
            }
          });
        } finally {
          await page.evaluate(() => window.localStorage.setItem('insights-view', 'chart'));
          await page.emulateMedia({ colorScheme: 'light' });
        }
      });

      test(`axe finds no serious or critical violations on Análises when empty or failed (${scheme})`, async () => {
        await prepare();
        const failing = await page.context().newPage();
        try {
          await failing.emulateMedia({ colorScheme: scheme });
          for (const size of sizes) {
            await page.setViewportSize(size);
            await visit(`/insights?end=${cal.month(-60).slice(0, 7)}`);
            await expect(trends()).toContainText('Sem movimentos contabilizados');
            expect(await axeViolations(page), `axe empty (${scheme}) ${size.width}px`).toEqual([]);
          }
          await withoutTable('category_group', async () => {
            for (const size of sizes) {
              await failing.setViewportSize(size);
              await failing.goto('/insights');
              await expect(
                failing.getByText('Não foi possível carregar as despesas por grupo.'),
              ).toBeVisible();
              expect(
                await axeViolations(failing),
                `axe failed (${scheme}) ${size.width}px`,
              ).toEqual([]);
            }
          });
        } finally {
          await failing.close();
          await page.emulateMedia({ colorScheme: 'light' });
        }
      });
    }

    test('Análises fits a 320px phone without sideways scrolling, charts and tables', async () => {
      await withInsightsData(cal, async (d) => {
        await page.setViewportSize({ width: 320, height: 640 });
        await open(d, '&range=12');
        await expect(page.getByTestId('insights-trends-chart')).toBeVisible();
        await groups()
          .nth(0)
          .getByRole('button', { name: /P5 Casa/ })
          .click();
        await expectNoOverflow(page, 'insights-');
        await expectNoOverflow(page, 'cashflow-');
        await snap(page, 'B7-insights-320');
        // The plots shrink with their cards instead of keeping a pixel width.
        for (const id of ['insights-trends-chart', 'cashflow-by-month']) {
          const box = await page.getByTestId(id).locator('svg.absolute').boundingBox();
          expect(box!.x + box!.width, `${id} inside the phone`).toBeLessThanOrEqual(320 - 16 + 1);
          expect(box!.width, `${id} drawn`).toBeGreaterThan(150);
        }
        // The summary stacks (label left, amount right) instead of three cramped columns.
        const stacked = await cashFlow()
          .getByTestId('cashflow-in')
          .evaluate((el) => getComputedStyle(el).display);
        expect(stacked).toBe('flex');

        await open(d, '&range=12', 'table');
        await expect(page.getByTestId('insights-trends-table')).toBeVisible();
        await expectNoOverflow(page, 'insights-');
        await snap(page, 'B8-insights-tables-320');
        // On a phone the trends are stacked rows (a definition list per month), so nothing in
        // the block needs a sideways scroll.
        const region = page.getByTestId('insights-trends-table');
        expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
        await page.evaluate(() => window.localStorage.setItem('insights-view', 'chart'));

        await visit(`/insights?end=${cal.month(-60).slice(0, 7)}`);
        await expect(trends()).toContainText('Sem movimentos contabilizados');
        await expectNoOverflow(page, 'insights-');
        await snap(page, 'B9-insights-empty-320');
      });
    });

    test('the charts follow the window when it is resized from 1280 to 390', async () => {
      await withInsightsData(cal, async (d) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await open(d, '&range=3');
        const svg = page.getByTestId('insights-trends-chart').locator('svg.absolute');
        await expect(svg).toBeVisible();
        const wide = (await svg.boundingBox())!;
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(async () => (await svg.boundingBox())!.width, { message: 'the plot narrows' })
          .toBeLessThan(wide.width - 400);
        const narrow = (await svg.boundingBox())!;
        expect(narrow.x + narrow.width).toBeLessThanOrEqual(390);
        // Redrawn for the new width, not squeezed: the viewBox follows the frame.
        const viewBox = await svg.getAttribute('viewBox');
        expect(Number(viewBox!.split(' ')[2])).toBeCloseTo(narrow.width, -1);
        await expectNoOverflow(page, 'insights-');
        await page.setViewportSize({ width: 1280, height: 800 });
        await expect
          .poll(async () => (await svg.boundingBox())!.width)
          .toBeGreaterThan(narrow.width + 400);
        await expectNoOverflow(page, 'insights-');
      });
    });
  });

  test('nothing in the console or the CSP report went wrong', () => {
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Push settings. Playwright's Chromium cannot reach a real push service, so the page gets a
// scripted PushManager and Notification (state kept in localStorage, so a reload keeps it).

interface PushMockSetup {
  permission?: 'default' | 'granted' | 'denied';
  /** What the permission prompt answers when it is asked. */
  onRequest?: 'granted' | 'denied' | 'default';
  /** Host of the endpoint the "push service" hands out. */
  host?: string;
  /** Remove PushManager, as an unsupported browser. */
  unsupported?: boolean;
  userAgent?: string;
  /** Launched from the home screen (iOS `navigator.standalone`). */
  standalone?: boolean;
  /** The browser already holds a subscription made with another VAPID key, at this endpoint. */
  staleEndpoint?: string;
}

interface PushMockState {
  permission: string;
  subscription: { endpoint: string; key: string } | null;
  requests: number;
  subscribeCalls: number;
  unsubscribeCalls: number;
  keyBytes: number;
}

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Installed once per context. It stays inert until a spec calls `setPushMock`. */
async function installPushMock(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    const KEY = '__pushMock';
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(KEY);
    } catch {
      return;
    }
    if (!raw) return;
    const read = () => JSON.parse(window.localStorage.getItem(KEY)!);
    const write = (value: unknown) => window.localStorage.setItem(KEY, JSON.stringify(value));
    const setup = read().setup as Record<string, unknown>;
    const define = (object: object, name: string, value: unknown) =>
      Object.defineProperty(object, name, { configurable: true, get: () => value });
    if (setup.userAgent) define(navigator, 'userAgent', setup.userAgent);
    if (setup.standalone !== undefined) define(navigator, 'standalone', setup.standalone);
    if (setup.unsupported) {
      Reflect.deleteProperty(window, 'PushManager');
      return;
    }
    const base64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const fromBase64url = (value: string) => {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
      return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    };
    const wrap = () => {
      const subscription = read().subscription as {
        endpoint: string;
        p256dh: string;
        auth: string;
        key: string;
      };
      return {
        endpoint: subscription.endpoint,
        options: { applicationServerKey: fromBase64url(subscription.key).buffer },
        toJSON: () => ({
          endpoint: subscription.endpoint,
          expirationTime: null,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }),
        unsubscribe: async () => {
          const state = read();
          state.subscription = null;
          state.unsubscribeCalls += 1;
          write(state);
          return true;
        },
      };
    };
    const pushManager = {
      getSubscription: async () => (read().subscription ? wrap() : null),
      subscribe: async (options: { applicationServerKey: ArrayBuffer }) => {
        const state = read();
        state.subscribeCalls += 1;
        state.keyBytes = new Uint8Array(options.applicationServerKey).length;
        state.subscription = {
          key: base64url(new Uint8Array(options.applicationServerKey)),
          endpoint: `https://${setup.host ?? 'fcm.googleapis.com'}/fcm/send/${base64url(random(18))}`,
          p256dh: base64url(new Uint8Array([4, ...random(64)])),
          auth: base64url(random(16)),
        };
        write(state);
        return wrap();
      },
    };
    define(navigator.serviceWorker, 'ready', Promise.resolve({ pushManager }));
    define(navigator.serviceWorker, 'getRegistration', async () => ({ pushManager }));
    class MockNotification {
      static get permission() {
        return read().permission;
      }
      static async requestPermission() {
        const state = read();
        state.requests += 1;
        if (state.permission === 'default') state.permission = setup.onRequest ?? 'granted';
        write(state);
        return state.permission;
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification });
  });
}

/** Sets the scripted browser for the page's next load (and clears what the last one did). */
async function setPushMock(page: Page, setup: PushMockSetup = {}): Promise<void> {
  await page.evaluate(
    ([setupJson, permission]) => {
      const parsed = JSON.parse(setupJson) as PushMockSetup;
      const bytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
      const base64url = (value: Uint8Array) =>
        btoa(String.fromCharCode(...value))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      window.localStorage.setItem(
        '__pushMock',
        JSON.stringify({
          setup: parsed,
          permission,
          subscription: parsed.staleEndpoint
            ? {
                endpoint: parsed.staleEndpoint,
                p256dh: 'p',
                auth: 'a',
                key: base64url(new Uint8Array([4, ...bytes(64)])),
              }
            : null,
          requests: 0,
          subscribeCalls: 0,
          unsubscribeCalls: 0,
          keyBytes: 0,
        }),
      );
    },
    [JSON.stringify(setup), setup.permission ?? 'default'] as const,
  );
}

const pushMock = (page: Page): Promise<PushMockState> =>
  page.evaluate(() => JSON.parse(window.localStorage.getItem('__pushMock')!) as PushMockState);

test.describe('phase 5: push settings', () => {
  const problems: string[] = [];
  let browser: Browser;
  let page: Page;
  let ownerId: string;
  let viewerId: string;

  const status = () => page.getByTestId('push-status');
  const region = () => page.getByRole('region', { name: 'Notificações' });
  const devices = () => page.getByTestId('push-devices');
  const PREFERENCES = '/settings/preferences';

  const pushRows = (userId?: string) =>
    sql<{ id: string; user_id: string; endpoint: string; user_agent: string | null }>(
      `select id, user_id, endpoint, user_agent from push_subscription
        ${userId ? 'where user_id = $1' : ''} order by created_at`,
      userId ? [userId] : [],
    );
  const testRows = () =>
    sql<{ user_id: string | null; payload: unknown; dedupe_key: string }>(
      `select user_id, payload, dedupe_key from notification where kind = 'push_test'`,
    );

  /** Loads the preferences page with a scripted browser and waits for the state to settle. */
  async function open(setup: PushMockSetup, state: string): Promise<void> {
    await setPushMock(page, setup);
    await page.goto(PREFERENCES);
    await expect(status()).toHaveAttribute('data-state', state);
  }

  /** A second device of the owner, as another browser would have stored it. */
  async function seedDevice(
    name: string,
    userAgent: string,
    extra: { lastSuccessHoursAgo?: number; failures?: number } = {},
  ): Promise<string> {
    const row = await sql<{ id: string }>(
      `insert into push_subscription (household_id, user_id, endpoint, p256dh, auth, user_agent,
         last_success_at, failure_count)
       values ($1, $2, $3, 'p', 'a', $4,
         case when $5::int is null then null else now() - make_interval(hours => $5::int) end, $6)
       returning id`,
      [
        await householdId(),
        ownerId,
        `https://fcm.googleapis.com/fcm/send/p5-seed-${name}`,
        userAgent,
        extra.lastSuccessHoursAgo ?? null,
        extra.failures ?? 0,
      ],
    );
    return row[0]!.id;
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const context = await newOwnerContext(b);
    await installPushMock(context);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    ownerId = (
      await sql<{ id: string }>(`select id from "user" where email = 'alex@example.com'`)
    )[0]!.id;
    viewerId = (
      await sql<{ id: string }>(`select id from "user" where email = $1`, [VIEWER.email])
    )[0]!.id;
    await sql('delete from push_subscription');
    await sql(`delete from notification where kind = 'push_test'`);
  });
  test.afterAll(async () => {
    await sql('delete from push_subscription');
    await sql(`delete from notification where kind = 'push_test'`);
    await page.context().close();
  });
  test.afterEach(async () => {
    // Every spec starts from no registered devices, whatever the one before it left.
    await sql('delete from push_subscription');
    await page.unrouteAll({ behavior: 'wait' });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('preferences lists Notificações between Tema and Sessão, with the privacy note', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open({}, 'default');
    const titles = await page
      .getByRole('main')
      .getByRole('heading', { level: 2 })
      .allTextContents();
    expect(titles).toEqual(['Idioma', 'Tema', 'Notificações', 'Sessão']);
    await expect(region()).toContainText('nunca mostram valores nem nomes de comerciantes');
    await expect(region().getByText('Ainda não ativadas neste dispositivo.')).toBeVisible();
    await expect(page.getByRole('link', { name: /Preferências/ }).first()).toBeVisible();
    // Nothing asked for permission on load.
    expect((await pushMock(page)).requests).toBe(0);
    await expect(devices()).toHaveCount(0);
    await expect(region().getByText('Nenhum dispositivo recebe notificações.')).toBeVisible();
    await shoot(page, 'C1-default', region());
  });

  test('enabling asks once, stores the device and lists it as this device', async () => {
    await open({ onRequest: 'granted' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    await expect(status()).toContainText('Ativas neste dispositivo.');
    await expect(page.getByText('Notificações ativadas neste dispositivo.')).toBeVisible();
    // Focus moves on to the next logical control.
    await expect(
      region().getByRole('button', { name: 'Enviar notificação de teste' }),
    ).toBeFocused();

    const mock = await pushMock(page);
    expect(mock.requests).toBe(1);
    expect(mock.subscribeCalls).toBe(1);
    // The browser was given the 65-byte public key, never anything else of the server's.
    expect(mock.keyBytes).toBe(65);
    const rows = await pushRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: ownerId, endpoint: mock.subscription!.endpoint });
    expect(rows[0]!.user_agent).toMatch(/Chrome/);

    const row = devices().getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Chrome em (Linux|Windows|macOS)/);
    await expect(row).toContainText('Este dispositivo');
    await expect(row).toContainText('Ainda sem entregas');
    await expect(row).not.toContainText(rows[0]!.endpoint);
    await shoot(page, 'C2-subscribed', region());

    // A reload still knows this browser is the registered one, and keeps its subscription: the
    // key matches the current one, so nothing is replaced.
    await page.reload();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    await expect(devices().getByRole('listitem')).toContainText('Este dispositivo');
    const after = await pushMock(page);
    expect(after.subscribeCalls).toBe(1);
    expect(after.unsubscribeCalls).toBe(0);
    expect(after.subscription!.endpoint).toBe(mock.subscription!.endpoint);
  });

  test('the test notification is a user-scoped push_test that never reaches the bell', async () => {
    await open({ onRequest: 'granted' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');

    const bell = page.getByRole('button', { name: /^Notificações/ });
    const bellBefore = await bell.getAttribute('aria-label');
    const send = region().getByRole('button', { name: 'Enviar notificação de teste' });
    await send.click();
    await expect(
      region().getByText(
        'Pedido enviado. A notificação deve chegar dentro de um minuto a todos os seus dispositivos.',
      ),
    ).toBeVisible();
    // Unavailable for a minute, but still focusable: the keyboard user is not thrown out of the page.
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toBeFocused();
    await expect(send).toHaveAttribute('aria-describedby', 'push-test-wait');
    await expect(region().getByText('Pode enviar outra dentro de 1 minuto.')).toBeVisible();
    await shoot(page, 'C3-test-sent', region());

    const rows = await testRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(ownerId);
    expect(rows[0]!.payload).toEqual({});
    expect(rows[0]!.dedupe_key).toMatch(new RegExp(`^push-test:${ownerId}:\\d+$`));

    // Not in the bell: same unread count, and the panel has nothing about it.
    await page.reload();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    expect(await bell.getAttribute('aria-label')).toBe(bellBefore);
    await bell.click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await expect(page.getByText(/Notificação de teste|Notificações ativas/)).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('a test already requested this minute is said so, not reported as sent', async () => {
    await open({ onRequest: 'granted' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    await sql(`delete from notification where kind = 'push_test'`);
    // Seed this minute's dedupe key and the next one's, so the click hits one of them whichever
    // minute it lands in (the service buckets by floor(now / 60 s)).
    const bucket = Math.floor(Date.now() / 60_000);
    for (const minute of [bucket, bucket + 1]) {
      await sql(
        `insert into notification (household_id, user_id, kind, payload, dedupe_key)
         values ($1, $2, 'push_test', '{}', $3)`,
        [await householdId(), ownerId, `push-test:${ownerId}:${minute}`],
      );
    }
    await region().getByRole('button', { name: 'Enviar notificação de teste' }).click();
    await expect(
      region().getByText('Já foi pedida uma notificação de teste há menos de um minuto.'),
    ).toBeVisible();
    await expect(region().getByText('Pedido enviado.')).toHaveCount(0);
    expect(await testRows()).toHaveLength(2);
    await sql(`delete from notification where kind = 'push_test'`);
  });

  test('turning notifications off removes the device and drops the browser subscription', async () => {
    await open({ onRequest: 'granted' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    expect(await pushRows()).toHaveLength(1);
    await region().getByRole('button', { name: 'Desativar neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'granted-unsubscribed');
    await expect(status()).toContainText('Permitidas, mas este dispositivo não está registado.');
    await expect(page.getByText('Notificações desativadas neste dispositivo.')).toBeVisible();
    await expect(region().getByRole('button', { name: 'Ativar neste dispositivo' })).toBeFocused();
    expect(await pushRows()).toHaveLength(0);
    const mock = await pushMock(page);
    expect(mock.unsubscribeCalls).toBe(1);
    expect(mock.subscription).toBeNull();
    await expect(region().getByText('Nenhum dispositivo recebe notificações.')).toBeVisible();
    await shoot(page, 'C4-granted-not-registered', region());

    // From here it turns on again without a new prompt being needed.
    await region().getByRole('button', { name: 'Ativar neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    await region().getByRole('button', { name: 'Desativar neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'granted-unsubscribed');
    expect(await pushRows()).toHaveLength(0);
  });

  test('a subscription made with an old VAPID key is replaced with one made with the current key', async () => {
    const stale = 'https://fcm.googleapis.com/fcm/send/p5-stale-key';
    await sql(
      `insert into push_subscription (household_id, user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, 'p', 'a', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36')`,
      [await householdId(), ownerId, stale],
    );
    await open({ permission: 'granted', staleEndpoint: stale }, 'subscribed');
    const mock = await pushMock(page);
    expect(mock.unsubscribeCalls).toBe(1);
    expect(mock.subscribeCalls).toBe(1);
    expect(mock.keyBytes).toBe(65);
    expect(mock.subscription!.endpoint).not.toBe(stale);
    // The old row is gone, the new one is saved, and it is the one listed as this device.
    const rows = await pushRows(ownerId);
    expect(rows.map((r) => r.endpoint)).toEqual([mock.subscription!.endpoint]);
    await expect(devices().getByRole('listitem')).toHaveCount(1);
    await expect(devices().getByRole('listitem')).toContainText('Este dispositivo');
    await expect(region().getByRole('alert')).toHaveCount(0);
    // Reloading keeps it: the new subscription matches the current key.
    await page.reload();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    expect((await pushMock(page)).subscribeCalls).toBe(1);
    await sql('delete from push_subscription');
  });

  test('when replacing an old-key subscription fails, the error shows and nothing stale is left', async () => {
    const stale = 'https://fcm.googleapis.com/fcm/send/p5-stale-key-2';
    await sql(
      `insert into push_subscription (household_id, user_id, endpoint, p256dh, auth)
       values ($1, $2, $3, 'p', 'a')`,
      [await householdId(), ownerId, stale],
    );
    // The new endpoint is on a host the server refuses, so the save fails.
    await open(
      { permission: 'granted', staleEndpoint: stale, host: 'evil.example.test' },
      'granted-unsubscribed',
    );
    await expect(region().getByRole('alert')).toContainText('Não foi possível ativar');
    expect(await pushRows(ownerId)).toHaveLength(0);
    const mock = await pushMock(page);
    expect(mock.subscription).toBeNull();
    await expect(region().getByRole('button', { name: 'Ativar neste dispositivo' })).toBeEnabled();
  });

  test('an old-key subscription that is not this user’s is left for “Ativar”, never switched on silently', async () => {
    const stale = 'https://fcm.googleapis.com/fcm/send/p5-stale-key-other';
    await open({ permission: 'granted', staleEndpoint: stale }, 'granted-unsubscribed');
    expect(await pushRows(ownerId)).toHaveLength(0);
    const mock = await pushMock(page);
    expect(mock.subscription!.endpoint).toBe(stale);
  });

  test('an endpoint the server refuses shows an error and leaves nothing behind', async () => {
    await open({ onRequest: 'granted', host: 'evil.example.test' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(
      region().getByRole('alert').filter({ hasText: 'Não foi possível ativar as notificações.' }),
    ).toBeVisible();
    await expect(region().getByRole('alert')).toContainText(
      'Verifique a ligação e tente novamente.',
    );
    // The browser subscription is rolled back and the server never stored it.
    const mock = await pushMock(page);
    expect(mock.subscribeCalls).toBe(1);
    expect(mock.unsubscribeCalls).toBe(1);
    expect(mock.subscription).toBeNull();
    expect(await pushRows()).toHaveLength(0);
    // Allowed, not registered: the button is back for another try.
    await expect(status()).toHaveAttribute('data-state', 'granted-unsubscribed');
    await expect(region().getByRole('button', { name: 'Ativar neste dispositivo' })).toBeEnabled();
    await shoot(page, 'C5-enable-error', region());
  });

  test('a refused permission shows how to turn it back on, and nothing to press but reload', async () => {
    await open({ permission: 'denied' }, 'denied');
    await expect(status()).toContainText(
      'As notificações estão bloqueadas para este site neste navegador.',
    );
    await expect(status()).not.toContainText('Toque no cadeado');
    await expect(region()).toContainText('Abra as definições do site no navegador');
    await expect(region().getByRole('button', { name: 'Recarregar página' })).toBeVisible();
    await expect(region().getByRole('button', { name: /^Ativar/ })).toHaveCount(0);
    await shoot(page, 'C6-denied', region());

    // One platform's how-to at a time.
    await open(
      {
        permission: 'denied',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      },
      'denied',
    );
    await expect(region()).toContainText('Toque no cadeado junto ao endereço');
    await expect(region()).not.toContainText('Abra as definições do site');

    // Refusing the prompt moves to the same state and puts focus on the message.
    await open({ onRequest: 'denied' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'denied');
    await expect(status()).toBeFocused();
    expect(await pushRows()).toHaveLength(0);
  });

  test('a dismissed prompt stays in the not-enabled state with a note', async () => {
    await open({ onRequest: 'default' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(
      region().getByRole('status').filter({ hasText: 'Pedido fechado sem resposta.' }),
    ).toBeVisible();
    await expect(status()).toHaveAttribute('data-state', 'default');
    await expect(
      region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }),
    ).toBeEnabled();
    expect((await pushMock(page)).subscribeCalls).toBe(0);
  });

  test('unsupported browsers and iPhones outside the app get their own explanation', async () => {
    await open({ unsupported: true }, 'unsupported');
    await expect(status()).toContainText('Este navegador não suporta notificações.');
    await expect(region().getByRole('button')).toHaveCount(0);
    await shoot(page, 'C7-unsupported', region());

    await open({ unsupported: true, userAgent: IPHONE_UA }, 'ios-install');
    await expect(status().getByText('Adicione ao ecrã principal primeiro')).toBeVisible();
    const steps = status().getByRole('listitem');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Toque em Partilhar');
    await expect(steps.nth(1)).toContainText('Escolha Adicionar ao ecrã principal.');
    await expect(steps.nth(2)).toContainText(
      'Abra Casa Exemplo a partir do novo ícone e volte aqui.',
    );
    await expect(status()).toContainText('Requer iOS 16.4 ou posterior.');
    await expect(region().getByRole('button')).toHaveCount(0);
    await shoot(page, 'C8-ios-install', region());

    // Installed on the iPhone, denied: the how-to is the iOS one.
    await open({ permission: 'denied', userAgent: IPHONE_UA, standalone: true }, 'denied');
    await expect(region()).toContainText('Abra Definições › Notificações › Casa Exemplo');
  });

  test('devices list who delivered what, and flags the ones that fail', async () => {
    await seedDevice('ff', 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0', {
      lastSuccessHoursAgo: 2,
      failures: 3,
    });
    await seedDevice('mystery', 'curl/8.0');
    try {
      await open({}, 'default');
      const rows = devices().getByRole('listitem');
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: 'Firefox em Android' })).toContainText(
        'Última entrega há 2 h',
      );
      await expect(rows.filter({ hasText: 'Firefox em Android' })).toContainText(
        'Entregas a falhar',
      );
      await expect(rows.filter({ hasText: 'Dispositivo desconhecido' })).toContainText(
        'Ainda sem entregas',
      );
      await expect(rows.filter({ hasText: 'Este dispositivo' })).toHaveCount(0);
      await shoot(page, 'C9-devices', region());
    } finally {
      await sql('delete from push_subscription');
    }
  });

  test('removing another device asks first; cancelling keeps it', async () => {
    await seedDevice('ff', 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0');
    await seedDevice(
      'win',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    );
    try {
      await open({}, 'default');
      const remove = (name: string) => region().getByRole('button', { name: `Remover ${name}` });
      await remove('Firefox em Android').click();
      const dialog = page.getByRole('alertdialog', { name: 'Remover Firefox em Android?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        'Esse dispositivo deixa de receber notificações até as voltar a ativar nele.',
      );
      await shoot(page, 'C10-remove-dialog');
      await dialog.getByRole('button', { name: 'Cancelar' }).click();
      // Focus goes back to the Remover that opened it.
      await expect(remove('Firefox em Android')).toBeFocused();
      await expect(dialog).toBeHidden();
      expect(await pushRows()).toHaveLength(2);

      await remove('Firefox em Android').click();
      await dialog.getByRole('button', { name: 'Remover', exact: true }).click();
      await expect(page.getByText('Dispositivo removido.')).toBeVisible();
      await expect(devices().getByRole('listitem')).toHaveCount(1);
      expect(await pushRows()).toHaveLength(1);
      // Focus lands on the next row's button, not on the page.
      await expect(remove('Firefox em Windows')).toBeFocused();

      // The last one: no row left, so focus goes to the list heading.
      await remove('Firefox em Windows').click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remover', exact: true })
        .click();
      await expect(region().getByText('Nenhum dispositivo recebe notificações.')).toBeVisible();
      await expect(region().getByRole('heading', { name: 'Os seus dispositivos' })).toBeFocused();
      expect(await pushRows()).toHaveLength(0);
    } finally {
      await sql('delete from push_subscription');
    }
  });

  test('removing this device from the list needs no dialog and turns it off here', async () => {
    await open({ onRequest: 'granted' }, 'default');
    await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
    await expect(status()).toHaveAttribute('data-state', 'subscribed');
    await region()
      .getByRole('button', { name: /^Remover Chrome em (Linux|Windows|macOS)$/ })
      .click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(status()).toHaveAttribute('data-state', 'granted-unsubscribed');
    await expect(page.getByText('Dispositivo removido.')).toBeVisible();
    expect(await pushRows()).toHaveLength(0);
    expect((await pushMock(page)).unsubscribeCalls).toBe(1);
  });

  test('the device list failing leaves this device usable', async () => {
    await withoutTable('push_subscription', async () => {
      await setPushMock(page);
      await page.goto(PREFERENCES);
      await expect(region().getByText('Não foi possível carregar os dispositivos.')).toBeVisible();
      await expect(region().getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
      await expect(region().getByRole('alert')).toBeVisible();
    });
    await expect(status()).toHaveAttribute('data-state', 'default');
    await expect(
      region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }),
    ).toBeEnabled();
    await shoot(page, 'C11-devices-error', region());
  });

  test('a viewer manages only their own device and can send a test', async () => {
    const ctx = await newOwnerContext(browser);
    await installPushMock(ctx);
    const guest = await ctx.newPage();
    const guestProblems: string[] = [];
    watch(guest, guestProblems);
    try {
      await guest.goto('/sign-in');
      await guest.getByLabel('Email').fill(VIEWER.email);
      await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
      await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(guest).toHaveURL(/\/$/);
      await seedDevice(
        'owner-only',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36',
      );
      await guest.goto(PREFERENCES);
      await setPushMock(guest, { onRequest: 'granted' });
      await guest.goto(PREFERENCES);
      const gStatus = guest.getByTestId('push-status');
      await expect(gStatus).toHaveAttribute('data-state', 'default');
      // The owner's device is not the viewer's to see.
      await expect(guest.getByTestId('push-devices')).toHaveCount(0);
      await guest.getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
      await expect(gStatus).toHaveAttribute('data-state', 'subscribed');
      await expect(guest.getByTestId('push-devices').getByRole('listitem')).toHaveCount(1);
      expect(await pushRows(viewerId)).toHaveLength(1);
      expect(await pushRows(ownerId)).toHaveLength(1);

      await guest.getByRole('button', { name: 'Enviar notificação de teste' }).click();
      await expect(guest.getByText('Pedido enviado.')).toBeVisible();
      expect((await testRows()).filter((r) => r.user_id === viewerId)).toHaveLength(1);
      await shoot(guest, 'C12-push-viewer');

      await guest.getByRole('button', { name: 'Desativar neste dispositivo' }).click();
      await expect(gStatus).toHaveAttribute('data-state', 'granted-unsubscribed');
      expect(await pushRows(viewerId)).toHaveLength(0);
      expect(await pushRows(ownerId)).toHaveLength(1);

      // Signing out releases this device: the server row and the browser subscription are gone
      // (it matters on a shared tablet), and the owner's device is untouched. Same session as
      // above: the sign-in endpoint allows five attempts a minute.
      await guest.getByRole('button', { name: 'Ativar neste dispositivo' }).click();
      await expect(gStatus).toHaveAttribute('data-state', 'subscribed');
      expect(await pushRows(viewerId)).toHaveLength(1);
      const before = (await pushMock(guest)).unsubscribeCalls;
      await guest.getByRole('button', { name: 'Terminar sessão' }).click();
      await expect(guest).toHaveURL(/\/sign-in/);
      expect(await pushRows(viewerId)).toHaveLength(0);
      const after = await pushMock(guest);
      expect(after.subscription).toBeNull();
      expect(after.unsubscribeCalls).toBe(before + 1);
      expect(await pushRows(ownerId)).toHaveLength(1);
      expect(guestProblems).toEqual([]);
    } finally {
      await sql('delete from push_subscription');
      await ctx.close();
    }
  });

  // One axe check per state, light and dark, so a failure names the state.
  const AXE_STATES: Array<[string, PushMockSetup, string, boolean]> = [
    ['not enabled', {}, 'default', false],
    ['subscribed with devices', {}, 'subscribed', true],
    ['allowed, not registered', { permission: 'granted' }, 'granted-unsubscribed', false],
    ['denied', { permission: 'denied' }, 'denied', false],
    ['unsupported', { unsupported: true }, 'unsupported', false],
    ['iPhone outside the app', { unsupported: true, userAgent: IPHONE_UA }, 'ios-install', false],
  ];
  for (const [name, setup, state, subscribe] of AXE_STATES) {
    test(`axe: ${name}`, async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      if (subscribe) {
        await seedDevice(
          'axe-ff',
          'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
          {
            lastSuccessHoursAgo: 5,
            failures: 2,
          },
        );
        await open({ onRequest: 'granted' }, 'default');
        await region()
          .getByRole('button', { name: 'Ativar notificações neste dispositivo' })
          .click();
      } else {
        await open(setup, state);
      }
      try {
        await expect(status()).toHaveAttribute('data-state', state);
        await expectAccessible(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await expectAccessible(page);
      } finally {
        await sql('delete from push_subscription');
      }
    });
  }

  test('axe: the remove dialog', async () => {
    await seedDevice(
      'dlg',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
    );
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open({}, 'default');
      await region().getByRole('button', { name: 'Remover Firefox em Windows' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expectAccessible(page);
    } finally {
      await sql('delete from push_subscription');
    }
  });

  test('every state fits a 320px phone, with tap targets of 44px', async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    await seedDevice(
      'long',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      { lastSuccessHoursAgo: 30, failures: 4 },
    );
    try {
      await open({ onRequest: 'granted' }, 'default');
      await expectNoOverflow(page, 'push-');
      await snap(page, 'C13-default-320');
      await region().getByRole('button', { name: 'Ativar notificações neste dispositivo' }).click();
      await expect(status()).toHaveAttribute('data-state', 'subscribed');
      await expectNoOverflow(page, 'push-');
      // Buttons stack at full width; each row's Remover is a 44px target.
      const test = await region()
        .getByRole('button', { name: 'Enviar notificação de teste' })
        .boundingBox();
      const off = await region()
        .getByRole('button', { name: 'Desativar neste dispositivo' })
        .boundingBox();
      expect(test!.width).toBeGreaterThan(250);
      expect(off!.y).toBeGreaterThan(test!.y + test!.height);
      for (const remove of await region()
        .getByRole('button', { name: /^Remover / })
        .all()) {
        const box = await remove.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      await region().getByRole('button', { name: 'Enviar notificação de teste' }).click();
      await expect(region().getByText('Pode enviar outra dentro de 1 minuto.')).toBeVisible();
      await expectNoOverflow(page, 'push-');
      await snap(page, 'C14-subscribed-320');

      await open({ permission: 'denied' }, 'denied');
      await expectNoOverflow(page, 'push-');
      await snap(page, 'C15-denied-320');
      await open({ unsupported: true, userAgent: IPHONE_UA }, 'ios-install');
      await expectNoOverflow(page, 'push-');
      await snap(page, 'C16-ios-320');
      await open({ unsupported: true }, 'unsupported');
      await expectNoOverflow(page, 'push-');
      await expectAccessible(page);
    } finally {
      await sql('delete from push_subscription');
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test('nothing in the console or the CSP report went wrong', () => {
    expect(problems).toEqual([]);
  });

  // Financial forms posted before hydration. Without `method="post"` a native submit is a GET and
  // every field (amounts, names) lands in the URL. These pages are server-rendered: a POST to them
  // must answer normally and never echo what was posted. (Here, not in a describe of its own: it
  // reuses this session, because the sign-in endpoint allows five attempts a minute.)
  const PAGES: Array<[string, string]> = [
    ['new asset', '/net-worth/assets/new'],
    ['new liability', '/net-worth/liabilities/new'],
    ['new goal', '/net-worth/goals/new'],
    ['new budget', '/budget/new'],
    ['new budget line', '/budget/lines/new'],
    ['budget settings', '/settings/budget'],
  ];
  PAGES.forEach(([name, path], index) => {
    test(`${name}: a native submit is a POST with nothing in the URL and nothing echoed`, async ({
      browser,
    }) => {
      const marker = `pre-hydration-p5-${index}-4242`;
      const res = await nativeSubmit(
        browser,
        path,
        async (p) => {
          const form = p.locator('main form').first();
          const field = form.locator(
            'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])',
          );
          // Some forms only have choices (selects, cards): their fields would still show in a GET URL.
          if ((await field.count()) > 0) await field.first().fill(marker);
          // `submit()` skips validation, as a native Enter on a late-hydrating page would not.
          await form.evaluate((el) => (el as HTMLFormElement).submit());
        },
        await page.context().storageState(),
      );
      expect(res.url).not.toContain(marker);
      // A GET submit would append every field as a query string.
      expect(new URL(res.url).search).toBe('');
      expect(res.urls.filter((u) => u.includes(marker))).toEqual([]);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(marker);
    });
  });
});
