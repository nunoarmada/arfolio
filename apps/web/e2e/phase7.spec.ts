import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { PASSWORD, axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

const VIEWER = { email: 'vic@example.com' };
const LIST = '/insights/reports';

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

/** The household's calendar: the closed months the spec seeds, as `yyyy-mm`. */
async function calendar() {
  const timezone = (
    await sql<{ timezone: string }>('select timezone from household_settings limit 1')
  )[0]!.timezone;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const month = (delta: number): string => {
    const total = get('year') * 12 + get('month') - 1 + delta;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  };
  const label = (m: string): string =>
    new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${m}-01T00:00:00Z`),
    );
  return { month, label };
}

const CONTENT = {
  headline: 'Um mês equilibrado, com a mercearia acima do habitual',
  overview:
    'As despesas ficaram perto do previsto. **Não é negrito** e <b>isto não é HTML</b>.\nSegunda linha do resumo.',
  findings: [
    { title: 'Poupança em alta', detail: 'Poupou mais do que no mês anterior.', tone: 'positive' },
    {
      title: 'Mercearia acima do habitual',
      detail: 'Gastou 450,00 € em mercearia.',
      tone: 'attention',
    },
    { title: 'Rendimento estável', detail: 'O rendimento manteve-se.', tone: 'neutral' },
  ],
  suggestions: [
    { title: 'Rever a mercearia', detail: 'Defina um limite semanal para a mercearia.' },
  ],
};

const LONG_NAME = 'Supercalifragilisticexpialidocious'.repeat(3);
const LINE_ID = randomUUID();
const CAT_ID = randomUUID();

const facts = (month: string) => ({
  schemaVersion: 1,
  month,
  currency: 'EUR',
  totals: { income: '3000.00', expense: '2100.50', saving: '400.00', net: '899.50' },
  previous: { income: '2900.00', expense: '1950.00', saving: '350.00', net: '-600.00' },
  avg3: { income: '2950.00', expense: '2000.00', saving: '375.00', net: '575.00' },
  groups: [],
  budgetLines: [],
  recurring: { monthlyCost: '123.40', changes: [] },
  netWorth: { now: '15000.00', monthStart: '14500.00', change12m: '2500.00' },
  anomalies: [
    {
      type: 'category_spike',
      categoryId: CAT_ID,
      name: 'Mercearia',
      amount: '450.00',
      baseline: '250.00',
    },
    {
      type: 'budget_overrun',
      lineId: LINE_ID,
      name: LONG_NAME,
      actual: '300.00',
      planned: '200.00',
    },
    { type: 'new_recurring', name: 'Ginásio Novo', amount: '29.90', cadence: 'monthly' },
    { type: 'recurring_price_change', name: 'Streaming', before: '9.99', after: '12.99' },
    { type: 'large_transaction', categoryName: 'Viagens', amount: '800.00', date: `${month}-14` },
  ],
  otherCurrencyCount: 2,
});

type Seed = {
  month: string;
  status: 'pending' | 'ready' | 'failed' | 'skipped';
  regenerations?: number;
  errorCode?: string;
};

/** Writes one report row as the database owner. No model is ever called. */
async function seed(row: Seed): Promise<void> {
  const ready = row.status === 'ready';
  await sql(
    `insert into ai_report (household_id, month, status, model, locale, facts, content,
       error_code, regenerations)
     values ($1, $2, $3, $4, 'pt-PT', $5, $6, $7, $8)
     on conflict (household_id, month) do update set status = excluded.status,
       model = excluded.model, facts = excluded.facts, content = excluded.content,
       error_code = excluded.error_code, regenerations = excluded.regenerations`,
    [
      await householdId(),
      `${row.month}-01`,
      row.status,
      ready ? 'claude-e2e-model' : null,
      ready || row.status === 'skipped' ? JSON.stringify(facts(row.month)) : null,
      ready ? JSON.stringify(CONTENT) : null,
      row.errorCode ?? null,
      row.regenerations ?? 0,
    ],
  );
}

const reportRow = async (month: string) =>
  (
    await sql<{ status: string; regenerations: number }>(
      `select status, regenerations from ai_report where month = $1`,
      [`${month}-01`],
    )
  )[0];

/** Both colour schemes, axe-clean (serious and critical violations). */
async function axeBoth(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The page never scrolls sideways at 320px. */
async function expectNoOverflowAt320(page: Page, label: string): Promise<void> {
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scroll,
    `${label}: scrollWidth ${overflow.scroll} > ${overflow.client}`,
  ).toBeLessThanOrEqual(overflow.client);
  await page.setViewportSize(original);
}

/** A real 320x700 viewport (light and dark), apart from the shared 390px shots. */
async function shoot320(page: Page, name: string, focus?: Locator): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width: 320, height: 700 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await focus?.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${name}-320-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(original);
}

test.describe('phase 7: AI reports and anomalies in Análises', () => {
  test.describe.configure({ mode: 'serial' });

  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let cal: Awaited<ReturnType<typeof calendar>>;
  let m1: string;
  let m2: string;
  let m3: string;
  let m4: string;
  let aiBefore: boolean;

  async function clean() {
    await sql('delete from ai_report');
  }
  const setAi = (on: boolean) => sql('update household_settings set ai_enabled = $1', [on]);

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    cal = await calendar();
    [m1, m2, m3, m4] = [cal.month(-1), cal.month(-2), cal.month(-3), cal.month(-4)] as [
      string,
      string,
      string,
      string,
    ];
    aiBefore = (await sql<{ a: boolean }>('select ai_enabled as a from household_settings'))[0]!.a;
    await clean();
    await setAi(true);
  });
  test.afterAll(async () => {
    await clean();
    await sql('update household_settings set ai_enabled = $1', [aiBefore]);
    await context.close();
  });
  test.afterEach(async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('Análises has Gráficos and Relatórios, and the placeholder note is gone', async () => {
    await page.goto('/insights');
    const nav = page.getByRole('navigation', { name: 'Análises: secções' });
    await expect(nav.getByRole('link', { name: 'Gráficos' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Análises', level: 1 })).toBeVisible();
    await nav.getByRole('link', { name: 'Relatórios' }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST}$`));
    await expect(
      page.getByRole('navigation', { name: 'Análises: secções' }).getByRole('link', {
        name: 'Relatórios',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('with no report the list still offers the last closed months, and the owner can generate', async () => {
    await page.goto(LIST);
    await expect(page.getByRole('heading', { name: 'Relatórios mensais', level: 2 })).toBeVisible();
    const rows = page.getByTestId('report-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText(cal.label(m1));
    await expect(rows.first()).toContainText('Sem relatório');
    await expect(rows.first()).toContainText(/anomalias?|Sem anomalias/);
    const card = page.getByTestId('reports-generate');
    await expect(card).toContainText(`Relatório de ${cal.label(m1)}`);
    await shoot(page, 'G1-list-empty', card);
    // The generate button fits a 320px screen without scrolling the page sideways.
    await expectNoOverflowAt320(page, 'reports list with the generate card');
    await shoot320(page, 'G1', card);
  });

  test('generate creates a pending row (no model call) and shows the pending state', async () => {
    await page.goto(LIST);
    await page
      .getByTestId('reports-generate')
      .getByRole('button', { name: 'Gerar relatório' })
      .click();
    await expect(page.getByTestId('report-row').first()).toContainText('Em preparação');
    await expect(page.getByTestId('reports-generate')).toHaveCount(0);
    expect(await reportRow(m1)).toEqual({ status: 'pending', regenerations: 0 });

    await page.getByTestId('report-row').first().click();
    await expect(page).toHaveURL(new RegExp(`${LIST}/${m1}$`));
    await expect(
      page.getByRole('heading', { name: `Relatório de ${cal.label(m1)}`, level: 1 }),
    ).toBeVisible();
    const pending = page.getByTestId('report-pending');
    await expect(pending).toContainText(`A preparar o relatório de ${cal.label(m1)}`);
    await expect(pending).toContainText('Costuma demorar alguns minutos');
    // Pending shows the pending state only: no AI text and no regenerate control.
    await expect(page.getByTestId('report-ai')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Gerar novamente' })).toHaveCount(0);
    await shoot(page, 'G3-detail-pending', pending);
  });

  test('a pending report updates itself when the worker finishes it', async () => {
    await page.goto(`${LIST}/${m1}`);
    await expect(page.getByTestId('report-pending')).toBeVisible();
    await seed({ month: m1, status: 'ready', regenerations: 0 });
    await expect(page.getByTestId('report-headline')).toHaveText(CONTENT.headline, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('report-pending')).toHaveCount(0);
    // The live region announced it.
    await expect(page.getByRole('status').filter({ hasText: 'está pronto' })).toHaveCount(1);
  });

  test('a ready report: AI text as plain text, tone words, figures, numbers and a footnote', async () => {
    await seed({ month: m2, status: 'pending' });
    await seed({ month: m3, status: 'failed', errorCode: 'provider_error' });
    await seed({ month: m4, status: 'skipped' });
    await page.goto(LIST);
    const rows = page.getByTestId('report-row');
    await expect(rows).toHaveCount(4);
    const ready = rows.filter({ hasText: cal.label(m1) });
    await expect(ready).toContainText(CONTENT.headline);
    await expect(ready).toContainText('Pronto');
    await expect(ready).toContainText('5 anomalias');
    await expect(ready).toContainText('Gerado a');
    await expect(rows.filter({ hasText: cal.label(m2) })).toContainText('Em preparação');
    await expect(rows.filter({ hasText: cal.label(m3) })).toContainText('Falhou');
    await expect(rows.filter({ hasText: cal.label(m4) })).toContainText('Sem dados suficientes');
    await shoot(page, 'G2-list', page.getByTestId('report-list'));
    await shoot320(page, 'G2', page.getByTestId('report-list'));

    await ready.click();
    const ai = page.getByTestId('report-ai');
    await expect(ai.getByRole('heading', { name: 'Resumo da IA', level: 2 })).toBeVisible();
    await expect(page.getByTestId('report-headline')).toHaveText(CONTENT.headline);
    // Model text is a text node: the markup and markdown characters show literally.
    await expect(ai).toContainText('**Não é negrito** e <b>isto não é HTML</b>.');
    await expect(ai.locator('b, strong')).toHaveCount(0);
    for (const word of ['Positivo', 'Atenção', 'Nota']) {
      await expect(ai.getByText(word, { exact: true })).toBeVisible();
    }
    await expect(ai.getByRole('heading', { name: 'O que se destacou', level: 3 })).toBeVisible();
    await expect(ai.getByRole('heading', { name: 'Sugestões', level: 3 })).toBeVisible();
    await expect(ai).toContainText('Rever a mercearia');
    await expect(ai).toContainText('Gerado por IA — confirme os números. Modelo claude-e2e-model');

    const anomalies = page.getByTestId('report-anomalies');
    await expect(anomalies.getByRole('heading', { name: /^Anomalias/, level: 2 })).toBeVisible();
    await expect(anomalies).toContainText('Valores de');
    await expect(anomalies.getByTestId('anomaly')).toHaveCount(5);
    await expect(anomalies).toContainText('Gasto acima do habitual em Mercearia');
    await expect(anomalies).toContainText(`${eur(45000)} · habitual ${eur(25000)}`);
    await expect(anomalies).toContainText(`${LONG_NAME} acima do previsto`);
    await expect(anomalies).toContainText(
      `${eur(30000)} de ${eur(20000)} · mais ${eur(10000)} do que o previsto`,
    );
    await expect(anomalies).toContainText(`${eur(2990)} · mensal`);
    await expect(anomalies).toContainText('Streaming mudou de preço');
    await expect(anomalies).toContainText('Movimento grande em Viagens');
    await expect(anomalies).toContainText(eur(80000));
    // Links: movements of the month for that category, the budget line with a way back, subscriptions.
    const spike = anomalies.getByRole('link', { name: /Ver movimentos\s*: Mercearia/ });
    await expect(spike).toHaveAttribute('href', new RegExp(`category=${CAT_ID}`));
    await expect(spike).toHaveAttribute('href', new RegExp(`from=${m1}-01`));
    await expect(anomalies.getByRole('link', { name: /Ver rubrica/ })).toHaveAttribute(
      'href',
      `/budget/lines/${LINE_ID}?back=%2Finsights%2Freports%2F${m1}`,
    );
    await expect(
      anomalies.getByRole('link', { name: /Ver subscrições\s*: Streaming/ }),
    ).toHaveAttribute('href', '/budget/subscriptions');

    const numbers = page.getByTestId('report-numbers');
    const table = numbers.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveCount(4);
    await expect(table.getByRole('row', { name: /^Entradas/ })).toContainText(eur(300000));
    await expect(table.getByRole('row', { name: /^Saldo/ })).toContainText(eur(89950));
    await expect(table.getByRole('row', { name: /^Saldo/ })).toContainText(`−${eur(60000)}`);
    await expect(numbers).toContainText('Média 3 meses');
    await expect(numbers).toContainText(`variação no mês +${eur(50000)}`);
    await expect(numbers).toContainText(`em 12 meses +${eur(250000)}`);
    await expect(numbers).toContainText(eur(12340));
    await expect(numbers).toContainText('2 movimentos noutra moeda ficaram fora destes valores.');
    await expect(
      numbers.getByRole('link', { name: `Ver gráficos de ${cal.label(m1)}` }),
    ).toHaveAttribute('href', `/insights?end=${m1}`);
    // The regenerate control and what is left, before it is spent.
    await expect(ai.getByRole('button', { name: 'Gerar novamente' })).toBeVisible();
    await expect(ai).toContainText('Pode gerar novamente mais 3 vezes.');
    await shoot(page, 'G4-detail-ready', ai);
    await shoot320(page, 'G4', ai);
    await shoot(page, 'G5-detail-anomalies', anomalies);
    await shoot(page, 'G6-detail-numbers', numbers);
  });

  test('failed and skipped months say so, and offer to try again', async () => {
    await page.goto(`${LIST}/${m3}`);
    const failed = page.getByTestId('report-failed');
    await expect(failed).toContainText(`Não foi possível gerar o relatório de ${cal.label(m3)}.`);
    await expect(failed).toContainText('Referência: provider_error');
    // Not the last closed month: nothing to press.
    await expect(failed.getByRole('button')).toHaveCount(0);
    await shoot(page, 'G7-detail-failed', failed);

    await page.goto(`${LIST}/${m4}`);
    const skipped = page.getByTestId('report-skipped');
    await expect(skipped).toContainText('Sem movimentos suficientes neste mês');
    await expect(skipped).toContainText(
      `Não houve entradas nem despesas contabilizadas em ${cal.label(m4)}.`,
    );
    await shoot(page, 'G8-detail-skipped', skipped);

    // The last closed month failed: the owner retries it, and it counts as a regeneration.
    await seed({ month: m1, status: 'failed', errorCode: 'provider_error', regenerations: 1 });
    await page.goto(`${LIST}/${m1}`);
    await expect(page.getByTestId('report-failed')).toContainText(
      'Conta como uma das 3 novas gerações',
    );
    await expect(page.getByTestId('report-failed')).toContainText(
      'Pode gerar novamente mais 2 vezes.',
    );
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(page.getByTestId('report-pending')).toBeVisible();
    // The button is gone: focus moves to the pending heading instead of falling to the page.
    await expect(
      page.getByRole('heading', { name: `A preparar o relatório de ${cal.label(m1)}` }),
    ).toBeFocused();
    expect(await reportRow(m1)).toEqual({ status: 'pending', regenerations: 2 });
  });

  test('regenerating asks first and respects the limit of three', async () => {
    await seed({ month: m1, status: 'ready', regenerations: 2 });
    await page.goto(`${LIST}/${m1}`);
    await expect(page.getByTestId('report-ai')).toContainText('Pode gerar novamente mais 1 vez.');
    await page.getByRole('button', { name: 'Gerar novamente' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Gerar novamente o relatório de ${cal.label(m1)}?`);
    await expect(dialog).toContainText('Depois disto não restam novas gerações.');
    await shoot(page, 'G9-regenerate-dialog');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await reportRow(m1)).toEqual({ status: 'ready', regenerations: 2 });
    await expect(page.getByRole('button', { name: 'Gerar novamente' })).toBeFocused();

    await page.getByRole('button', { name: 'Gerar novamente' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Gerar novamente' }).click();
    await expect(page.getByTestId('report-pending')).toBeVisible();
    expect(await reportRow(m1)).toEqual({ status: 'pending', regenerations: 3 });

    // At the limit the button is gone and the page says why.
    await seed({ month: m1, status: 'ready', regenerations: 3 });
    await page.goto(`${LIST}/${m1}`);
    await expect(page.getByRole('button', { name: 'Gerar novamente' })).toHaveCount(0);
    await expect(page.getByTestId('report-ai')).toContainText(
      `O relatório de ${cal.label(m1)} já foi gerado novamente 3 vezes, o máximo para um mês.`,
    );
    await expect(page.getByTestId('report-ai')).toContainText('gerado novamente');
  });

  test('a month with no report shows its anomalies, calculated now', async () => {
    await sql('delete from ai_report where month = $1', [`${m4}-01`]);
    await page.goto(`${LIST}/${m4}`);
    await expect(page.getByTestId('report-none')).toContainText(
      `Sem relatório para ${cal.label(m4)}`,
    );
    const anomalies = page.getByTestId('report-anomalies');
    await expect(anomalies).toContainText('Calculado agora a partir dos movimentos.');
    await expect(anomalies.getByRole('heading', { name: /^Anomalias/ })).toBeVisible();
    await expect(page.getByTestId('report-ai')).toHaveCount(0);
    await expect(page.getByTestId('report-numbers')).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: `Ver gráficos de ${cal.label(m4)}` }),
    ).toHaveAttribute('href', `/insights?end=${m4}`);
    await shoot(page, 'G10-detail-no-report');
  });

  test('months that cannot be reported are not found', async () => {
    for (const path of [
      `${LIST}/${cal.month(0)}`,
      `${LIST}/${cal.month(1)}`,
      `${LIST}/2026-13`,
      `${LIST}/abc`,
      `${LIST}/${cal.month(-40)}`,
    ]) {
      // The loading shell streams first, so the page is the 404 content rather than a 404 status.
      await page.goto(path);
      await expect(
        page.getByRole('heading', { name: 'Página não encontrada' }),
        path,
      ).toBeVisible();
      await expect(page.getByTestId('report-ai'), path).toHaveCount(0);
    }
  });

  test('a viewer reads reports and anomalies but has nothing to press', async ({ browser }) => {
    await seed({ month: m1, status: 'ready', regenerations: 0 });
    await sql('delete from ai_report where month = $1', [`${m2}-01`]);
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

      await guest.goto(LIST);
      await expect(guest.getByTestId('report-row').first()).toContainText(CONTENT.headline);
      await expect(guest.getByRole('main').getByRole('button')).toHaveCount(0);
      await guest.getByTestId('report-row').first().click();
      await expect(guest.getByTestId('report-headline')).toHaveText(CONTENT.headline);
      await expect(guest.getByTestId('report-anomalies').getByTestId('anomaly')).toHaveCount(5);
      await expect(guest.getByRole('button', { name: /^Gerar/ })).toHaveCount(0);
      await expect(guest.getByTestId('report-ai')).not.toContainText('Pode gerar novamente');
      // A viewer cannot edit a budget line, so the overrun has no link for them.
      await expect(guest.getByRole('link', { name: /Ver rubrica/ })).toHaveCount(0);
      await expect(guest.getByRole('link', { name: /Ver movimentos/ }).first()).toBeVisible();
      await shoot(guest, 'G11-detail-viewer');

      // No report for the last closed month: told it is coming, with nothing to press.
      await sql('delete from ai_report where month = $1', [`${m1}-01`]);
      await guest.goto(LIST);
      await expect(guest.getByTestId('reports-first-soon')).toContainText(
        'O primeiro relatório está a caminho',
      );
      await expect(guest.getByRole('main').getByRole('button')).toHaveCount(0);

      // AI off: the explanation for someone who is not an owner.
      await setAi(false);
      await guest.goto(LIST);
      const off = guest.getByTestId('reports-ai-off');
      await expect(off).toContainText('A IA está desativada neste agregado');
      await expect(off).toContainText('Só um proprietário do agregado a pode ativar');
      await expect(off.getByRole('link')).toHaveCount(0);
      expect(guestProblems).toEqual([]);
    } finally {
      await setAi(true);
      await ctx.close();
    }
  });

  test('AI off: the owner is pointed to the household settings, old reports stay readable', async () => {
    await seed({ month: m2, status: 'ready', regenerations: 3 });
    await setAi(false);
    try {
      await page.goto(LIST);
      const off = page.getByTestId('reports-ai-off');
      await expect(off).toContainText('A IA está desativada neste agregado');
      await expect(off.getByRole('link', { name: 'Abrir definições do agregado' })).toHaveAttribute(
        'href',
        '/settings/household#ai',
      );
      await expect(page.getByTestId('reports-generate')).toHaveCount(0);
      await expect(page.getByTestId('report-row').filter({ hasText: cal.label(m2) })).toContainText(
        CONTENT.headline,
      );
      await shoot(page, 'G12-list-ai-off', off);
      await axeBoth(page, 'reports list, AI off');

      await page.goto(`${LIST}/${m2}`);
      await expect(page.getByTestId('report-headline')).toBeVisible();
      await expect(page.getByRole('button', { name: /^Gerar/ })).toHaveCount(0);
      await expect(page.getByTestId('report-ai')).toContainText(
        'A IA está desativada: não são gerados novos relatórios.',
      );

      // The deep link lands on the AI switch.
      await page.goto(`${LIST}`);
      await off.getByRole('link', { name: 'Abrir definições do agregado' }).click();
      await expect(page).toHaveURL(/\/settings\/household#ai$/);
      await expect(
        page.getByRole('region', { name: /^IA: categorias e relatórios/ }),
      ).toBeVisible();
    } finally {
      await setAi(true);
    }
  });

  test('no API key on the installation: a short note for everyone, anomalies still there', async () => {
    const other = await context.newPage();
    const otherProblems: string[] = [];
    watch(other, otherProblems);
    try {
      await other.goto(`${process.env.E2E_NOAI_URL}${LIST}`);
      const note = other.getByTestId('reports-no-key');
      await expect(note).toContainText('Relatórios com IA indisponíveis');
      await expect(note).toContainText('não tem uma chave de API de IA');
      await expect(other.getByTestId('reports-generate')).toHaveCount(0);
      await expect(other.getByTestId('report-row').first()).toBeVisible();
      await shoot(other, 'G13-list-no-key', note);
    } finally {
      await other.close();
    }
  });

  test('the household AI switch describes the monthly reports and what is sent', async () => {
    await page.goto('/settings/household');
    const section = page.getByRole('region', { name: 'IA: categorias e relatórios' });
    await expect(section).toContainText(
      'no início de cada mês, escreve um relatório do mês anterior',
    );
    await expect(section).toContainText('Para os relatórios:');
    await expect(section).toContainText(
      'pagamentos recorrentes, pelo nome só quando os confirmou ou renomeou e, caso contrário, pela categoria',
    );
    await expect(section).toContainText('Nunca a descrição dos movimentos.');
    await expect(section).toContainText('Os relatórios nunca incluem descrições.');
    await expect(section).toContainText(
      'Um relatório por mês, que pode ser gerado novamente até 3 vezes.',
    );
    await expect(section).toHaveAttribute('id', 'ai');
  });

  test('accessible in light and dark, and nothing overflows at 320px', async () => {
    await seed({ month: m1, status: 'ready', regenerations: 0 });
    await seed({ month: m2, status: 'pending' });

    await page.goto(LIST);
    await expect(page.getByTestId('report-list')).toBeVisible();
    await axeBoth(page, 'reports list');
    await expectNoOverflowAt320(page, 'reports list');

    await page.goto(`${LIST}/${m1}`);
    await expect(page.getByTestId('report-numbers')).toBeVisible();
    await axeBoth(page, 'ready report');
    await expectNoOverflowAt320(page, 'ready report');
    await page.setViewportSize({ width: 320, height: 700 });
    await shoot(page, 'G14-detail-320');

    await page.goto(`${LIST}/${m2}`);
    await expect(page.getByTestId('report-pending')).toBeVisible();
    await axeBoth(page, 'pending report');
    await expectNoOverflowAt320(page, 'pending report');
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
