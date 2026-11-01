import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
  type Route,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { depreciatedValue, scheduledBalanceAt } from '../../../packages/core/src/net-worth';
import { mkdirSync } from 'node:fs';
import { buildBudgetSheet } from '../../../packages/services/test/fixtures/budget-sheet';
import { PASSWORD, axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

const VIEWER = { email: 'vic@example.com' };

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

/** Calls a server action directly (as a script would), by the name the build manifest knows it by. */
async function callAction(
  request: APIRequestContext,
  file: string,
  exportedName: string,
  args: unknown[],
): Promise<string> {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../.next/server/server-reference-manifest.json', import.meta.url)),
      'utf8',
    ),
  ) as { node: Record<string, { exportedName: string; filename: string }> };
  const id = Object.entries(manifest.node).find(
    ([, v]) => v.exportedName === exportedName && v.filename.endsWith(file),
  )?.[0];
  expect(id, `${exportedName} is in the server reference manifest`).toBeTruthy();
  const res = await request.post('/net-worth', {
    headers: {
      'Next-Action': id!,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    data: JSON.stringify(args),
  });
  return res.text();
}

const MONEY = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
});
/** Minor units as the app writes them in pt-PT ("1 240,00 €"). */
const eur = (cents: number): string => MONEY.format(cents / 100);
/** What a figure on the page says, as minor units ("−1 240,00 €" gives -124000). */
function cents(text: string): number {
  const negative = /[−-]/.test(text);
  const digits = text.replace(/[^\d,]/g, '').replace(',', '.');
  const value = Math.round(Number(digits) * 100);
  return negative ? -value : value;
}

/** Today in the household's time zone, and the dates the spec derives from it. */
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
  return { today: day(0), day, month };
}

/** "ago. 26": what a narrow table says for a month. */
const monthShort = (iso: string): string => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  const month = new Intl.DateTimeFormat('pt-PT', { month: 'short', timeZone: 'UTC' }).format(d);
  const year = new Intl.DateTimeFormat('pt-PT', { year: '2-digit', timeZone: 'UTC' }).format(d);
  return `${month} ${year}`;
};

const monthTitle = (iso: string): string => {
  const text = new Intl.DateTimeFormat('pt-PT', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso.slice(0, 7)}-01T00:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
};

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

/** No page-level horizontal scroll: only a table region may scroll sideways. */
async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `page overflow at ${page.url()}`).toBeLessThanOrEqual(0);
}

/** The link of a plain account row (its name starts the row, as a whole word). */
const accountLink = (name: string): RegExp =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);

/** A screenshot at the viewport the page is at (the 320px checks), when screenshots are on. */
async function snap(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_SCREENSHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

/**
 * The visible label of a radio card (the radio itself is visually hidden). Scoped to the cards: a
 * details select on the same form may have an option with the same text ("Outro").
 */
const pickKind = (page: Page, label: string) =>
  page
    .locator('label')
    .filter({ has: page.getByRole('radio') })
    .getByText(label, { exact: true })
    .click();

test.describe.configure({ mode: 'serial' });

test.describe('phase 4: net worth', () => {
  const problems: string[] = [];
  let browser: Browser;
  let page: Page;
  let cal: Awaited<ReturnType<typeof calendar>>;
  let baseline = 0;
  let apartmentUrl = '';
  let mortgageUrl = '';
  let apartmentId = '';
  let mortgageId = '';
  let linkedAccountName = '';
  const MORTGAGE = {
    principal: 24_000_000,
    annualRateBps: 350,
    termMonths: 360,
    start: '2023-09-01',
  };

  const total = async (): Promise<number> =>
    cents((await page.getByTestId('net-worth-total').textContent()) ?? '');

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
  // Navigation

  test('the phone has five tabs, Património is the fourth and Mais links to Objetivos', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/more');
    const tabs = page.getByRole('navigation', { name: 'Principal' });
    for (const name of ['Início', 'Movimentos', 'Orçamento', 'Património', 'Mais']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expect(tabs.getByRole('link')).toHaveCount(5);
    await expect(tabs.getByRole('link').nth(3)).toHaveText('Património');
    await expect(page.getByRole('link', { name: /^Objetivos/ })).toBeVisible();
    await page.getByRole('link', { name: /^Objetivos/ }).click();
    await expect(page).toHaveURL(/\/net-worth\/goals$/);
    await expect(page.getByRole('heading', { name: 'Objetivos', level: 1 })).toBeVisible();
    await shoot(page, '223-goals-placeholder');
    // Goals live inside the Património tab.
    await expect(tabs.getByRole('link', { name: 'Património' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const subnav = page.getByRole('navigation', { name: 'Secções do património' });
    await subnav.getByRole('link', { name: 'Resumo' }).click();
    await expect(page).toHaveURL(/\/net-worth$/);
    await expect(subnav.getByRole('link', { name: 'Resumo' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    const side = page.getByRole('complementary');
    await expect(side.getByRole('link', { name: 'Património' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('at 320px every tab label fits on one line inside its cell', async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/net-worth');
    const tabs = page.getByRole('navigation', { name: 'Principal' });
    await expect(tabs.getByRole('link')).toHaveCount(5);
    const fits = await tabs.getByRole('link').evaluateAll((links) =>
      links.map((link) => {
        const text = [...link.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).at(-1)!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const box = range.getBoundingClientRect();
        const cell = link.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          label: link.textContent,
          width: box.width,
          cell: cell.width,
          lines: Math.round(box.height / parseFloat(getComputedStyle(link).lineHeight)),
          font: parseFloat(getComputedStyle(link).fontSize),
        };
      }),
    );
    for (const f of fits) {
      expect(f.lines, `${f.label} is one line`).toBe(1);
      expect(f.width, `${f.label} fits its ${f.cell}px cell`).toBeLessThanOrEqual(f.cell);
      expect(f.font, `${f.label} is not shrunk`).toBeGreaterThanOrEqual(12);
    }
    // The labels sit side by side: at least 6px of air between neighbours.
    fits.slice(1).forEach((f, i) => {
      expect(
        f.left - fits[i]!.right,
        `${fits[i]!.label} and ${f.label} are 6px or more apart`,
      ).toBeGreaterThanOrEqual(6);
    });
    await expectNoPageOverflow(page);
    await snap(page, '200-tabbar-320');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // -------------------------------------------------------------------------------------------
  // Nothing in net worth yet

  test('with nothing counted the page explains it and offers the first steps', async () => {
    // Earlier specs left accounts (and the budget import some assets and credits): take them all
    // out of net worth for a moment.
    const counted = await sql<{ id: string }>(
      'select id from financial_account where include_in_net_worth',
    );
    const assets = await sql<{ id: string }>('select id from asset where not archived');
    const liabilities = await sql<{ id: string }>('select id from liability where not archived');
    await sql('update financial_account set include_in_net_worth = false');
    await sql('update asset set archived = true where not archived');
    await sql('update liability set archived = true where not archived');
    try {
      await page.goto('/net-worth');
      await expect(
        page.getByRole('heading', { name: 'Ainda não há nada no património.' }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Adicionar ativo' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Adicionar passivo' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Importar da folha de cálculo' })).toBeVisible();
      await shoot(page, '201-nw-empty');
    } finally {
      await sql('update financial_account set include_in_net_worth = true where id = any($1)', [
        counted.map((c) => c.id),
      ]);
      await sql('update asset set archived = false where id = any($1)', [assets.map((a) => a.id)]);
      await sql('update liability set archived = false where id = any($1)', [
        liabilities.map((l) => l.id),
      ]);
    }
  });

  // -------------------------------------------------------------------------------------------
  // An apartment and a mortgage with a schedule

  test('creating an apartment: first value, back on its page', async () => {
    await page.goto('/net-worth');
    await expect(page.getByRole('heading', { name: 'Património', level: 1 })).toBeVisible();
    baseline = await total();

    await page.getByRole('button', { name: 'Adicionar' }).click();
    await snap(page, '221-add-menu');
    await page.getByRole('menuitem', { name: 'Ativo' }).click();
    await expect(page).toHaveURL(/\/net-worth\/assets\/new$/);
    await expect(page.getByRole('heading', { name: 'Novo ativo', level: 1 })).toBeVisible();

    // Submitting nothing explains what is missing, with a link to the field.
    await page.getByRole('button', { name: 'Guardar' }).click();
    const summary = page.getByRole('alert').filter({ hasText: 'Corrija 1 campo' });
    await expect(summary).toBeVisible();
    await expect(page.getByText('Indique o nome do ativo.').first()).toBeVisible();
    await summary.getByRole('button', { name: /Nome/ }).click();
    await expect(page.getByLabel('Nome', { exact: true })).toBeFocused();

    await pickKind(page, 'Imóvel');
    await page.getByLabel('Nome', { exact: true }).fill('Apartamento');
    await page.getByLabel('Valor', { exact: true }).fill('250000');
    await page.getByLabel('Data', { exact: true }).fill(cal.day(-60));
    await shoot(page, '202-asset-form');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    apartmentUrl = new URL(page.url()).pathname;
    apartmentId = apartmentUrl.split('/').at(-1)!;
    await expect(page.getByRole('heading', { name: 'Apartamento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('detail-value')).toHaveText(eur(25_000_000));
  });

  test('creating a mortgage with a schedule: live preview, then the plan', async () => {
    await page.goto('/net-worth/liabilities/new');
    await pickKind(page, 'Hipoteca');
    await page.getByLabel('Nome', { exact: true }).fill('Hipoteca casa');
    await page.getByLabel('Ativo financiado').selectOption({ label: 'Apartamento' });

    const plan = page.getByRole('group', { name: 'Plano de pagamentos' });
    await plan.getByLabel('Montante inicial').fill('240000');
    // A plan with a missing field is refused, and the page says which rule applies.
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText('Preencha os quatro campos do plano ou deixe-os vazios.').first(),
    ).toBeVisible();
    await plan.getByLabel('Taxa anual (%)').fill('3,5');
    await plan.getByLabel('Anos').fill('30');
    await plan.getByLabel('Data de início').fill(MORTGAGE.start);
    const payment = 1_077_71;
    await expect(page.getByTestId('schedule-preview')).toContainText(
      `Prestação estimada: ${eur(payment)} por mês · fim em setembro de 2053`,
    );
    await shoot(page, '203-liability-form', page.getByTestId('schedule-preview'));
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Passivo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/liabilities\/[0-9a-f-]{36}$/);
    mortgageUrl = new URL(page.url()).pathname;
    mortgageId = mortgageUrl.split('/').at(-1)!;

    const owed = scheduledBalanceAt(
      {
        principal: MORTGAGE.principal,
        annualRateBps: MORTGAGE.annualRateBps,
        termMonths: MORTGAGE.termMonths,
        startDate: MORTGAGE.start,
      },
      cal.today,
    );
    await expect(page.getByRole('heading', { name: 'Hipoteca casa', level: 1 })).toBeVisible();
    await expect(page.getByTestId('detail-value')).toHaveText(eur(owed));
    await expect(page.getByText('Segundo o plano de pagamentos').first()).toBeVisible();
    // The meta line names the house and links to it.
    await expect(page.getByRole('link', { name: 'Apartamento' })).toHaveAttribute(
      'href',
      apartmentUrl,
    );

    const card = page.getByRole('region', { name: 'Plano de pagamentos' });
    await expect(card.getByTestId('schedule-payment')).toHaveText(eur(payment));
    await expect(card.getByTestId('schedule-remaining')).toContainText('anos');
    await expect(card.getByText('Capital amortizado')).toBeVisible();
    const meter = card.getByRole('meter', { name: 'Capital amortizado' });
    await expect(meter).toHaveAttribute('aria-valuetext', /de .* \(\d+ %\)/);
    // Twelve instalments from this month, this month marked.
    await expect(
      card.getByRole('table', { name: 'Próximas prestações' }).locator('tbody tr'),
    ).toHaveCount(12);
    await expect(card.locator('tr[aria-current="date"]')).toHaveCount(1);
    await shoot(page, '204-liability-detail', card);

    await card.getByRole('button', { name: 'Ver plano completo (360 prestações)' }).click();
    const full = card.getByRole('region', { name: 'Plano de pagamentos completo' });
    await expect(full).toBeVisible();
    await expect(full.locator('tbody tr')).toHaveCount(360);
    await full.focus();
    await expect(full).toBeFocused();
    await shoot(page, '205-schedule-full', full);
    await card.getByRole('button', { name: 'Mostrar só os próximos 12 meses' }).click();
    await expect(full).toHaveCount(0);
  });

  test('net worth shows both, and the totals add up', async () => {
    const owed = scheduledBalanceAt(
      {
        principal: MORTGAGE.principal,
        annualRateBps: MORTGAGE.annualRateBps,
        termMonths: MORTGAGE.termMonths,
        startDate: MORTGAGE.start,
      },
      cal.today,
    );
    await page.goto('/net-worth');
    const assets = page.getByRole('region', { name: 'Ativos' });
    const liabilities = page.getByRole('region', { name: 'Passivos' });
    await expect(assets.getByRole('link', { name: /Apartamento/ })).toBeVisible();
    await expect(assets.getByRole('heading', { name: 'Imóveis', level: 3 })).toBeVisible();
    await expect(liabilities.getByRole('link', { name: /Hipoteca casa/ })).toBeVisible();
    await expect(liabilities.getByRole('heading', { name: 'Hipotecas', level: 3 })).toBeVisible();
    await expect(page.getByTestId(`nw-item-${apartmentId}`)).toContainText(eur(25_000_000));
    await expect(page.getByTestId(`nw-item-${apartmentId}`)).toContainText('Avaliação manual');
    // A liability's amount is what is owed, positive, with a hidden prefix saying so.
    const mortgageRow = page.getByTestId(`nw-item-${mortgageId}`);
    await expect(mortgageRow).toContainText(eur(owed));
    await expect(mortgageRow).toContainText('Em dívida');
    await expect(mortgageRow).toContainText('Segundo o plano de pagamentos');
    expect(await total()).toBe(baseline + 25_000_000 - owed);
    await shoot(page, '206-nw-summary');
    await shoot(page, '207-nw-lists', assets);
  });

  // -------------------------------------------------------------------------------------------
  // A new value updates the history and the row

  test('adding a valuation updates the value, the history and the row', async () => {
    await page.goto(apartmentUrl);
    const history = page.locator('section', {
      has: page.getByRole('heading', { name: 'Histórico de valores' }),
    });
    await expect(history.locator('tbody tr')).toHaveCount(1);
    // One value 60 days back: the chart needs two months, so it is not there yet or has one point.
    await page.getByRole('button', { name: 'Atualizar valor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Atualizar valor' });
    await dialog.getByLabel('Data', { exact: true }).fill(cal.today);
    await dialog.getByLabel('Valor', { exact: true }).fill('260000');
    await dialog.getByLabel('Nota').fill('Avaliação do banco');
    await shoot(page, '208-valuation-sheet');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Valor registado')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('detail-value')).toHaveText(eur(26_000_000));
    await expect(history.locator('tbody tr')).toHaveCount(2);
    await expect(history.locator('tbody tr').first()).toContainText('Avaliação do banco');
    // Two months of values draw the compact chart, its readout at the latest value.
    const slider = page.getByRole('slider', { name: 'Mês no gráfico de valores' });
    await expect(slider).toBeVisible();
    await expect(page.getByTestId('chart-readout')).toContainText(eur(26_000_000));
    await shoot(page, '209-asset-detail', history);

    // The same day again replaces the value, and the sheet warns before it does.
    await page.getByRole('button', { name: 'Atualizar valor' }).click();
    const again = page.getByRole('dialog', { name: 'Atualizar valor' });
    await again.getByLabel('Data', { exact: true }).fill(cal.today);
    await expect(again.getByText(/^Já existe um valor a .* Guardar substitui-o\.$/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(again).toHaveCount(0);

    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${apartmentId}`)).toContainText(eur(26_000_000));
    const owed = scheduledBalanceAt(
      {
        principal: MORTGAGE.principal,
        annualRateBps: MORTGAGE.annualRateBps,
        termMonths: MORTGAGE.termMonths,
        startDate: MORTGAGE.start,
      },
      cal.today,
    );
    expect(await total()).toBe(baseline + 26_000_000 - owed);
  });

  test('a recorded balance beats the plan, and a divergence is explained', async () => {
    await page.goto(mortgageUrl);
    // Without balances the history offers the same action, so the first button is the hero's.
    await page.getByRole('button', { name: 'Atualizar saldo' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Atualizar saldo' });
    await dialog.getByLabel('Data', { exact: true }).fill(cal.today);
    await dialog.getByLabel('Saldo em dívida').fill('150000');
    await dialog.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Saldo registado', { exact: true })).toBeVisible();
    await expect(page.getByTestId('detail-value')).toHaveText(eur(15_000_000));
    await expect(page.getByText(/^Saldo registado a /)).toBeVisible();
    await expect(
      page.getByText(
        /O saldo registado \(.*\) difere do plano \(.*\)\. O património usa o saldo registado\./,
      ),
    ).toBeVisible();
    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${mortgageId}`)).toContainText(eur(15_000_000));
    await expect(page.getByTestId(`nw-item-${mortgageId}`)).toContainText('Avaliação manual');
  });

  // -------------------------------------------------------------------------------------------
  // The chart

  test('recalculating months draws the history; a missing month breaks the line', async () => {
    await page.goto('/net-worth');
    const figure = page.getByTestId('net-worth-chart');
    // Only the current month exists: a note instead of a plot.
    await expect(figure.getByText('O histórico começa este mês.')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await shoot(page, '210-chart-single');

    for (const [index, offset, label] of [
      [0, -1, 'o mês anterior'],
      [2, -3, 'há três meses'],
    ] as const) {
      await page.getByRole('button', { name: 'Recalcular um mês' }).click();
      const dialog = page.getByRole('dialog', { name: 'Recalcular um mês' });
      await expect(dialog.getByText(/Volta a calcular o valor guardado/)).toBeVisible();
      if (index === 0) await shoot(page, '222-recalculate-sheet');
      await dialog.getByLabel('Mês').selectOption({ index });
      await dialog.getByRole('button', { name: 'Recalcular', exact: true }).click();
      // Name the month: the previous month's toast can still be on screen.
      const month = monthTitle(cal.month(offset)).toLowerCase();
      await expect(page.getByText(`Património de ${month} recalculado`), label).toBeVisible();
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.getByRole('slider', { name: 'Mês no gráfico de património' })).toBeVisible();
    // Two months ago has no record: said in words, not drawn as zero.
    await expect(
      page.getByText(`Sem registo em ${monthTitle(cal.month(-2)).toLowerCase()}.`),
    ).toBeVisible();
    await expect(page.getByText('O mês corrente é calculado com os dados de hoje.')).toBeVisible();
    await shoot(page, '211-chart-gap', figure);
  });

  test('the chart slider works from the keyboard and skips the gap', async () => {
    await page.goto('/net-worth');
    const slider = page.getByRole('slider', { name: 'Mês no gráfico de património' });
    await expect(slider).toHaveAttribute('aria-valuemin', '0');
    await expect(slider).toHaveAttribute('aria-valuemax', '2');
    await expect(slider).toHaveAttribute('aria-valuenow', '2');
    await expect(slider).toHaveAttribute(
      'aria-valuetext',
      new RegExp(`^${monthTitle(cal.month(0))}: `),
    );
    await slider.focus();
    await expect(slider).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuenow', '1');
    await expect(slider).toHaveAttribute(
      'aria-valuetext',
      new RegExp(`^${monthTitle(cal.month(-1))}: `),
    );
    // The month before it has no record: the next step lands on the one before that.
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await expect(slider).toHaveAttribute(
      'aria-valuetext',
      new RegExp(`^${monthTitle(cal.month(-3))}: `),
    );
    await expect(slider).toHaveAttribute('aria-valuetext', /Primeiro mês com registo/);
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('aria-valuenow', '2');
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuenow', '2');
    await page.keyboard.press('PageDown');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await shoot(page, '212-chart-keyboard', page.getByTestId('net-worth-chart'));

    // "Mais recente" brings the readout back to the live month.
    await page.getByRole('button', { name: 'Mais recente' }).click();
    await expect(slider).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('button', { name: 'Mais recente' })).toHaveCount(0);
    // Pointer: pressing at the left edge of the plot picks the earliest month.
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    // The drawing itself is not read out: the slider and the caption carry it.
    await expect(page.getByTestId('net-worth-chart').locator('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(page.getByTestId('net-worth-chart').locator('figcaption')).toContainText(
      'Património líquido de',
    );
  });

  test('the chart follows the window when it narrows (no sideways scroll)', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/net-worth');
    const slider = page.getByRole('slider', { name: 'Mês no gráfico de património' });
    await expect(slider).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
    await expect.poll(async () => (await slider.boundingBox())!.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('the table is the same data, remembered between visits', async () => {
    await page.goto('/net-worth');
    await page.getByRole('button', { name: 'Ver como tabela' }).click();
    const table = page.getByRole('table', { name: 'Património líquido por mês' });
    await expect(table).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver gráfico' })).toBeVisible();
    await expect(
      table.getByRole('row', {
        name: new RegExp(
          `(${monthTitle(cal.month(-2))}|${monthShort(cal.month(-2))}).*Sem registo`,
        ),
      }),
    ).toBeVisible();
    await expect(table.getByText('em curso')).toBeVisible();
    // The columns that matter always fit; Ativos and Passivos join when the pane is wide.
    for (const name of ['Mês', 'Património líquido', 'Variação']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible();
    }
    await shoot(page, '213-history-table', table);
    await page.reload();
    await expect(page.getByRole('table', { name: 'Património líquido por mês' })).toBeVisible();
    await page.getByRole('button', { name: 'Ver gráfico' }).click();
    await expect(page.getByRole('slider', { name: 'Mês no gráfico de património' })).toBeVisible();
  });

  test('the range control is made of links and keeps Back working', async () => {
    await page.goto('/net-worth');
    const range = page.getByRole('navigation', { name: 'Período do gráfico' });
    await expect(range.getByRole('link', { name: '12 meses' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await range.getByRole('link', { name: '24 meses' }).click();
    await expect(page).toHaveURL(/range=24/);
    await expect(range.getByRole('link', { name: '24 meses' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await range.getByRole('link', { name: 'Tudo' }).click();
    await expect(page).toHaveURL(/range=all/);
    await expect(page.getByRole('slider', { name: 'Mês no gráfico de património' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/range=24/);
  });

  // -------------------------------------------------------------------------------------------
  // Linked records, other currencies, depreciation, archiving

  test('a record linked to an account is one row and counts once', async () => {
    linkedAccountName = (
      await sql<{ name: string }>(
        `select fa.name from financial_account fa
          where fa.include_in_net_worth and fa.archived_at is null and fa.currency = 'EUR'
            and not exists (select 1 from asset a where a.account_id = fa.id and not a.archived and a.disposed_on is null)
            and not exists (select 1 from liability l where l.account_id = fa.id and not l.archived and l.settled_on is null)
          order by fa.name limit 1`,
      )
    )[0]!.name;
    await page.goto('/net-worth');
    const before = await total();
    await expect(page.getByRole('link', { name: accountLink(linkedAccountName) })).toBeVisible();

    await page.goto('/net-worth/assets/new');
    await pickKind(page, 'Investimento');
    await page.getByLabel('Nome', { exact: true }).fill('Carteira ligada');
    await page.getByLabel('Ligar a uma conta').selectOption({ label: linkedAccountName });
    // A linked asset takes its value from the account: no first value to enter.
    await expect(page.getByRole('group', { name: 'Valor atual' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page.getByText(`O valor vem da conta ${linkedAccountName}.`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver conta' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Atualizar valor' })).toHaveCount(0);
    await shoot(page, '214-asset-linked');
    const linkedId = new URL(page.url()).pathname.split('/').at(-1)!;

    await page.goto('/net-worth');
    // One row, under the record's name, not two.
    await expect(page.getByTestId(`nw-item-${linkedId}`)).toContainText(
      `Via conta ${linkedAccountName}`,
    );
    await expect(page.getByRole('link', { name: accountLink(linkedAccountName) })).toHaveCount(0);
    expect(await total()).toBe(before);

    // Deleting it brings the plain account row back.
    await page.goto(`/net-worth/assets/${linkedId}`);
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Apagar Carteira ligada?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Apagar', exact: true }).click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth$/);
    await expect(page.getByRole('link', { name: accountLink(linkedAccountName) })).toBeVisible();
    expect(await total()).toBe(before);
  });

  test('an asset in another currency is listed, tagged and left out of the total', async () => {
    // Other items in other currencies may already be there: count them first.
    const foreignCount = async (): Promise<number> => {
      const text = await page
        .getByText(/noutra moeda n[ãa]o entra/)
        .first()
        .textContent({ timeout: 2_000 })
        .catch(() => null);
      return text ? Number(/^(\d+)/.exec(text)![1]) : 0;
    };
    await page.goto('/net-worth');
    const before = await total();
    const foreignBefore = await foreignCount();
    await page.goto('/net-worth/assets/new');
    await pickKind(page, 'Liquidez');
    await page.getByLabel('Nome', { exact: true }).fill('Conta em dólares');
    await page.getByLabel('Moeda').selectOption('USD');
    await page.getByLabel('Valor', { exact: true }).fill('1000');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByTestId('detail-value')).toHaveText(/^1\s000,00\sUS\$$/);
    await expect(page.getByText('Fora do total')).toBeVisible();

    await page.goto('/net-worth');
    await expect(
      page.getByText(
        foreignBefore === 0
          ? '1 item noutra moeda não entra no total (sem conversão de moeda).'
          : `${foreignBefore + 1} itens noutra moeda não entram no total (sem conversão de moeda).`,
      ),
    ).toBeVisible();
    const row = page.getByTestId(`nw-item-${id}`);
    await expect(row).toContainText('Fora do total');
    await expect(row).toContainText('US$');
    expect(await total()).toBe(before);
    await shoot(page, '215-nw-foreign', row);

    await page.goto(`/net-worth/assets/${id}`);
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth$/);
    await expect(page.getByTestId(`nw-item-${id}`)).toHaveCount(0);
    expect(await foreignCount()).toBe(foreignBefore);
  });

  test('when the first value cannot be saved, one message says the asset was created and why', async () => {
    await page.goto('/net-worth/assets/new');
    await pickKind(page, 'Outro');
    await page.getByLabel('Nome', { exact: true }).fill('Coleção');
    // Passes the form, is refused by the service (over the largest amount it keeps).
    await page.getByLabel('Valor', { exact: true }).fill('99999999999');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText(/^O ativo foi criado, mas o valor não foi guardado: /),
    ).toBeVisible();
    await expect(page.getByText('Ativo criado')).toHaveCount(0);
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: 'Coleção', level: 1 })).toBeVisible();
    await expect(page.getByText('Ainda não há valores registados.')).toBeVisible();
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
  });

  test('a depreciating vehicle is estimated, and deleting its only value says so', async () => {
    await page.goto('/net-worth/assets/new?kind=vehicle');
    await expect(page.getByLabel('Depreciação anual (%)')).toBeVisible();
    await page.getByLabel('Nome', { exact: true }).fill('Carro');
    await page.getByLabel('Depreciação anual (%)').fill('15');
    await page.getByLabel('Valor', { exact: true }).fill('10000');
    const from = cal.day(-365);
    await page.getByLabel('Data', { exact: true }).fill(from);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    const estimate = depreciatedValue(1_000_000, from, cal.today, 1500);
    await expect(page.getByTestId('detail-value')).toHaveText(eur(estimate));
    await expect(
      page.getByText(/^Estimativa de hoje a partir de .*, com depreciação de 15\s?%\/ano\.$/),
    ).toBeVisible();
    const id = new URL(page.url()).pathname.split('/').at(-1)!;

    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${id}`)).toContainText(eur(estimate));
    await expect(page.getByTestId(`nw-item-${id}`)).toContainText(
      /Estimado com depreciação de 15\s?%\/ano/,
    );

    await page.goto(`/net-worth/assets/${id}`);
    const heading = page.getByRole('heading', { name: 'Histórico de valores' });
    await page
      .getByRole('button', { name: /^Eliminar valor de / })
      .last()
      .click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Eliminar este valor?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByText('Valor eliminado')).toBeVisible();
    await expect(page.getByText('Ainda não há valores registados.')).toBeVisible();
    // Nothing left to move to: focus lands on the section heading.
    await expect(heading).toBeFocused();

    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${id}`)).toContainText('Sem valor ainda');
    await expect(page.getByTestId(`nw-item-${id}`)).toContainText('Toque para registar o valor');
    await shoot(page, '216-nw-no-value', page.getByTestId(`nw-item-${id}`));
    // The row still opens the page, where the value can be recorded.
    await page.getByTestId(`nw-item-${id}`).getByRole('link').click();
    await expect(page.getByRole('button', { name: 'Atualizar valor' }).first()).toBeVisible();
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
  });

  test('deleting the last value leaves focus on the history heading, however slowly the list refreshes', async () => {
    await page.goto('/net-worth/assets/new?kind=other');
    await page.getByLabel('Nome', { exact: true }).fill('Relógio');
    await page.getByLabel('Valor', { exact: true }).fill('500');
    await page.getByLabel('Data', { exact: true }).fill(cal.today);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);

    // The page refresh that drops the deleted row is held back, so the dialog has finished closing
    // (and Radix has returned focus to the delete button, which is still there) before the row is
    // gone. That is the order in which the heading used to lose focus. The page is shared with the
    // tests after this one, so the delay is lifted again as soon as it has done its job: left in
    // place, every later link prefetch took 1.5 s and the axe test never reached networkidle fast.
    const delayRefresh = async (route: Route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // A prefetch the page cancels during the delay is already handled; only that is expected.
      // Playwright then never marks this invocation as complete (see unrouteAll below).
      await route.continue().catch((error: Error) => {
        if (!/already handled/i.test(error.message)) throw error;
      });
    };
    const isRefresh = (url: URL) => url.searchParams.has('_rsc');
    await page.route(isRefresh, delayRefresh);
    try {
      const heading = page.getByRole('heading', { name: 'Histórico de valores' });
      await page
        .getByRole('button', { name: /^Eliminar valor de / })
        .last()
        .click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
      await expect(page.getByText('Ainda não há valores registados.')).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(heading).toBeFocused();
    } finally {
      // Not 'wait': that waits for every handler invocation that is still running when it is
      // called, and a prefetch the page cancels during its delay makes route.continue() throw, so
      // Playwright never completes that invocation and unrouteAll hangs until the test timeout.
      // 'ignoreErrors' removes the route at once; prefetches still held by the handler go on to
      // continue by themselves, and the ones the page cancelled are ignored. This is the only
      // route on the page here.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }

    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
  });

  test('a loan without a plan gets one later, with the same all-or-none rule', async () => {
    await page.goto('/net-worth/liabilities/new');
    await pickKind(page, 'Empréstimo');
    await page.getByLabel('Nome', { exact: true }).fill('Crédito automóvel');
    await page.getByLabel('Saldo em dívida').fill('5000');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Passivo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/liabilities\/[0-9a-f-]{36}$/);
    const url = new URL(page.url()).pathname;
    await expect(page.getByTestId('detail-value')).toHaveText(eur(500_000));
    const card = page.getByRole('region', { name: 'Plano de pagamentos' });
    await expect(card.getByText(/^Sem plano de pagamentos\./)).toBeVisible();
    await card.getByRole('link', { name: 'Definir plano' }).click();
    await expect(page).toHaveURL(/\/edit#schedule$/);
    const plan = page.getByRole('group', { name: 'Plano de pagamentos' });
    await expect(plan).toBeVisible();
    await plan.getByLabel('Montante inicial').fill('8000');
    await plan.getByLabel('Taxa anual (%)').fill('5');
    await plan.getByLabel('Meses').fill('48');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText('Preencha os quatro campos do plano ou deixe-os vazios.').first(),
    ).toBeVisible();
    await plan.getByLabel('Data de início').fill(cal.day(-200));
    await expect(page.getByTestId('schedule-preview')).toContainText('Prestação estimada:');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    await expect(page).toHaveURL(url);
    const filled = page.getByRole('region', { name: 'Plano de pagamentos' });
    await expect(filled.getByTestId('schedule-remaining')).toContainText('prestações');
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Passivo apagado')).toBeVisible();
  });

  test('editing an asset keeps its currency fixed', async () => {
    await page.goto(apartmentUrl);
    await page.getByRole('link', { name: 'Editar' }).click();
    await expect(page).toHaveURL(/\/edit$/);
    await expect(page.getByRole('heading', { name: 'Editar ativo', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Moeda')).toBeDisabled();
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Apartamento');
    await page.getByLabel('Notas').fill('T2 com garagem');
    // Leaving with unsaved edits asks first.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(
      page.getByRole('alertdialog').getByRole('button', { name: 'Continuar a editar' }),
    ).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continuar a editar' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    await expect(page).toHaveURL(apartmentUrl);
  });

  test('Home shows net worth and its change', async () => {
    await page.goto('/net-worth');
    const headline = await total();
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Património' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('home-net-worth')).toHaveText(eur(headline).replace('-', '−'));
    await expect(card.getByRole('link', { name: 'Ver património' })).toHaveAttribute(
      'href',
      '/net-worth',
    );
    await shoot(page, '217-home-card', card);
  });

  // -------------------------------------------------------------------------------------------
  // A viewer reads everything and changes nothing

  test('a viewer sees net worth, with no way to change it', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto('/net-worth');
    await expect(guest.getByRole('heading', { name: 'Património', level: 1 })).toBeVisible();
    await expect(guest.getByTestId('net-worth-total')).toBeVisible();
    await expect(guest.getByRole('link', { name: /^Apartamento/ })).toBeVisible();
    for (const name of ['Adicionar', 'Recalcular um mês']) {
      await expect(guest.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(guest.getByRole('link', { name: 'Importar da folha de cálculo' })).toHaveCount(0);
    // What can be read stays: the table toggle works.
    await expect(guest.getByRole('button', { name: /Ver como tabela|Ver gráfico/ })).toBeVisible();

    await guest.goto(apartmentUrl);
    await expect(guest.getByTestId('detail-value')).toHaveText(eur(26_000_000));
    await expect(guest.getByRole('button', { name: 'Atualizar valor' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Editar' })).toHaveCount(0);
    for (const name of ['Vender', 'Abater', 'Mais ações']) {
      await expect(guest.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(guest.getByRole('button', { name: /^Eliminar valor/ })).toHaveCount(0);
    await shoot(guest, '218-asset-viewer');

    await guest.goto(mortgageUrl);
    await expect(guest.getByTestId('schedule-payment')).toHaveText(eur(1_077_71));
    await expect(guest.getByRole('button', { name: 'Atualizar saldo' })).toHaveCount(0);
    for (const name of ['Liquidar', 'Mais ações']) {
      await expect(guest.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(
      guest.getByRole('button', { name: 'Ver plano completo (360 prestações)' }),
    ).toBeVisible();

    // Pages that write are not there at all, and neither are the actions behind them.
    for (const path of [
      '/net-worth/assets/new',
      '/net-worth/liabilities/new',
      `${apartmentUrl}/edit`,
      `${mortgageUrl}/edit`,
    ]) {
      await guest.goto(path);
      await expect(guest.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    }
    expect(
      await callAction(guest.request, 'net-worth.ts', 'createAssetAction', [
        {
          kind: 'cash',
          name: 'Sneaky',
          notes: null,
          accountId: null,
          depreciationBps: null,
          currency: 'EUR',
          initial: null,
        },
      ]),
    ).toContain('"code":"forbidden"');
    expect(
      await callAction(guest.request, 'net-worth.ts', 'recalculateNetWorthAction', [cal.month(-1)]),
    ).toContain('"code":"forbidden"');
    await ctx.close();
  });

  // -------------------------------------------------------------------------------------------
  // Loading and accessibility

  // -------------------------------------------------------------------------------------------
  // Objetivos

  /** The article of a goal card, by its name. */
  const goalCard = (name: string) => page.getByRole('article', { name, exact: true });
  /** A month as the goal card writes it ("outubro de 2027"). */
  const monthWords = (iso: string): string =>
    new Intl.DateTimeFormat('pt-PT', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${iso.slice(0, 7)}-01T00:00:00Z`),
    );
  /** Fills the goal form's plain fields (the radio choices are clicked on their visible labels). */
  async function fillGoal(
    name: string,
    fields: { target?: string; contribution?: string; date?: string },
  ) {
    await page.getByLabel('Nome', { exact: true }).fill(name);
    if (fields.target !== undefined)
      await page.getByLabel('Meta', { exact: true }).fill(fields.target);
    if (fields.contribution !== undefined) {
      await page.getByLabel('Contribuição mensal').fill(fields.contribution);
    }
    if (fields.date !== undefined) await page.getByLabel('Data pretendida').fill(fields.date);
  }

  test('with no goals the page invites the first one, and offers the emergency fund', async () => {
    const live = await sql<{ id: string }>('select id from goal where not archived');
    await sql('update goal set archived = true where not archived');
    try {
      await page.goto('/net-worth/goals');
      await expect(page.getByRole('heading', { name: 'Objetivos', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Ainda não há objetivos.' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Adicionar objetivo' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: 'Criar fundo de emergência' })).toBeVisible();
      await shoot(page, '301-goals-empty');
    } finally {
      await sql('update goal set archived = false where id = any($1)', [live.map((g) => g.id)]);
    }
  });

  test('a goal with a target and a contribution shows its projection', async () => {
    await page.goto('/net-worth/goals');
    await page.getByRole('link', { name: 'Adicionar objetivo' }).first().click();
    await expect(page.getByRole('heading', { name: 'Novo objetivo', level: 1 })).toBeVisible();
    // Empty and invalid input is explained, field by field.
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Corrija 1 campo' })).toBeVisible();
    await expect(page.getByText('Indique um nome.').first()).toBeVisible();
    await shoot(page, '303-goal-form-error');

    await fillGoal('Viagem ao Japão', {
      target: '3000',
      contribution: '250',
      date: cal.day(182),
    });
    await shoot(page, '302-goal-form');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Objetivo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/goals$/);

    const card = goalCard('Viagem ao Japão');
    await expect(card.getByTestId('goal-saved')).toHaveText(eur(0));
    await expect(card.getByText(`de ${eur(300_000)}`)).toBeVisible();
    await expect(card.getByTestId('goal-remaining')).toHaveText(eur(300_000));
    // 3 000 at 250 a month: twelve months from now.
    await expect(card.getByTestId('goal-expected')).toContainText(monthWords(cal.month(12)));
    await expect(card.getByTestId('goal-expected')).toContainText('daqui a 12 meses');
    const meter = card.getByRole('meter', { name: 'Progresso de Viagem ao Japão' });
    await expect(meter).toHaveAttribute(
      'aria-valuetext',
      new RegExp(
        `^${eur(0).replace(/\s/g, '\\s')} de ${eur(300_000).replace(/\s/g, '\\s')}, 0\\s%$`,
      ),
    );
    // Wanted in six months, reached in twelve: said in words, not only in colour.
    await expect(card.getByText(/^Depois da data pretendida \(/)).toBeVisible();
    await expect(card.getByText('Sem conta nem rubrica: o poupado fica a 0,00 €')).toBeVisible();
    await expect(page.getByTestId('goals-total-saved')).toBeVisible();
    await shoot(page, '304-goals');
  });

  test('a goal with no target shows no projection', async () => {
    await page.goto('/net-worth/goals/new');
    await fillGoal('Almofada', { contribution: '50' });
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Objetivo criado')).toBeVisible();
    const card = goalCard('Almofada');
    await expect(card.getByTestId('goal-saved')).toBeVisible();
    await expect(card.getByText('50,00 €/mês')).toBeVisible();
    await expect(card.getByText('Sem meta definida — sem projeção.')).toBeVisible();
    await expect(card.getByRole('meter')).toHaveCount(0);
    await expect(card.getByTestId('goal-remaining')).toHaveCount(0);
    await expect(card.getByTestId('goal-expected')).toHaveCount(0);
    await expect(card.getByText('Data prevista')).toHaveCount(0);
  });

  test('a goal can be linked to an account, and changed later', async () => {
    const savings = (
      await sql<{ name: string }>(
        `select name from financial_account where archived_at is null and currency = 'EUR' order by name limit 1`,
      )
    )[0]!.name;
    await page.goto('/net-worth/goals');
    await page.getByRole('link', { name: 'Editar Almofada' }).click();
    await expect(page.getByRole('heading', { name: 'Editar objetivo', level: 1 })).toBeVisible();
    await page.getByLabel('Meta', { exact: true }).fill('1000');
    await page.getByText('Numa conta', { exact: true }).click();
    await page.getByLabel('Conta', { exact: true }).selectOption({ label: savings });
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    const card = goalCard('Almofada');
    await expect(card.getByText(`Na conta ${savings}`)).toBeVisible();
    await expect(card.getByRole('meter', { name: 'Progresso de Almofada' })).toBeVisible();
    await expect(card.getByTestId('goal-expected')).toBeVisible();

    // Leaving with unsaved changes asks first.
    await page.getByRole('link', { name: 'Editar Almofada' }).click();
    await page.getByLabel('Nome', { exact: true }).fill('Almofada grande');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Sair sem guardar?' })).toBeVisible();
    await page.getByRole('button', { name: 'Continuar a editar' }).click();
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Almofada grande');
  });

  test('the emergency fund explains its target, and a second one cannot be created', async () => {
    await page.goto('/net-worth/goals');
    await page.getByRole('link', { name: 'Criar fundo de emergência' }).click();
    await expect(page.getByRole('heading', { name: 'Novo objetivo', level: 1 })).toBeVisible();
    // Preselected from the link; the target is calculated, not typed.
    await expect(page.getByRole('radio', { name: 'Fundo de emergência' })).toBeChecked();
    await expect(page.getByLabel('Meta', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Meta calculada: média das despesas planeadas/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Alterar número de meses' })).toHaveAttribute(
      'href',
      '/settings/household#emergency-fund',
    );
    await page.getByLabel('Nome', { exact: true }).fill('Reserva da casa');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Objetivo criado')).toBeVisible();

    const card = goalCard('Reserva da casa');
    await expect(card.getByText('Fundo de emergência', { exact: true })).toBeVisible();
    await expect(card.getByText(/^Meta = média das despesas planeadas/)).toBeVisible();
    await expect(card.getByText(/^de \d/)).toBeVisible();
    await shoot(page, '305-goals-emergency');
    // It comes first, ahead of the goals created before it.
    await expect(page.getByRole('article').first()).toHaveAccessibleName('Reserva da casa');
    // "Alterar meses" lands on the setting.
    await card.getByRole('link', { name: 'Alterar meses' }).click();
    await expect(page).toHaveURL(/\/settings\/household#emergency-fund$/);
    await expect(page.getByLabel('Fundo de emergência (meses)')).toBeVisible();

    // One is enough: no way to ask for another, in the list, in the form or behind it.
    await page.goto('/net-worth/goals');
    await expect(page.getByRole('link', { name: 'Criar fundo de emergência' })).toHaveCount(0);
    await page.goto('/net-worth/goals/new?kind=emergency_fund');
    await expect(page.getByRole('radio', { name: 'Fundo de emergência' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: 'Objetivo', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Meta', { exact: true })).toBeVisible();
    expect(
      await callAction(page.request, 'goals.ts', 'createGoalAction', [
        {
          kind: 'emergency_fund',
          name: 'Segunda reserva',
          targetAmount: null,
          targetDate: null,
          accountId: null,
          budgetLineId: null,
          monthlyContribution: null,
        },
      ]),
    ).toContain('emergency_fund_exists');
    expect(
      (
        await sql(
          "select count(*)::int as n from goal where kind = 'emergency_fund' and not archived",
        )
      )[0]!.n,
    ).toBe(1);
  });

  test('an emergency fund created meanwhile is explained in the form, not lost', async () => {
    const [fund] = await sql<{ id: string; household_id: string }>(
      "select id, household_id from goal where kind = 'emergency_fund' and not archived",
    );
    await sql('update goal set archived = true where id = $1', [fund!.id]);
    let extra = '';
    try {
      await page.goto('/net-worth/goals/new?kind=emergency_fund');
      await expect(page.getByRole('radio', { name: 'Fundo de emergência' })).toBeChecked();
      await page.getByLabel('Nome', { exact: true }).fill('Reserva dupla');
      // Someone else creates the household's emergency fund while this form is open.
      extra = (
        await sql<{ id: string }>(
          "insert into goal (household_id, kind, name) values ($1, 'emergency_fund', 'Reserva alheia') returning id",
          [fund!.household_id],
        )
      )[0]!.id;
      await page.getByRole('button', { name: 'Guardar' }).click();
      await expect(
        page.getByText(
          'O agregado já tem um fundo de emergência. Edite esse em vez de criar outro.',
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/net-worth\/goals\/new/);
      await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Reserva dupla');
    } finally {
      if (extra) await sql('delete from goal where id = $1', [extra]);
      await sql('update goal set archived = false where id = $1', [fund!.id]);
    }
  });

  test('an emergency fund with no budget says so and offers to create one', async () => {
    const live = await sql<{ id: string }>("select id from budget where status = 'active'");
    await sql("update budget set status = 'archived' where status = 'active'");
    try {
      await page.goto('/net-worth/goals');
      const card = goalCard('Reserva da casa');
      await expect(card.getByText('Sem orçamento ativo para calcular a meta.')).toBeVisible();
      await expect(card.getByRole('link', { name: 'Criar orçamento' })).toBeVisible();
      await expect(card.getByRole('meter')).toHaveCount(0);
      await shoot(page, '307-goals-no-budget');
    } finally {
      await sql("update budget set status = 'active' where id = any($1)", [live.map((b) => b.id)]);
    }
  });

  test('archiving a goal removes it from the list', async () => {
    await page.goto('/net-worth/goals');
    await page.getByRole('link', { name: 'Editar Almofada' }).click();
    await page.getByRole('button', { name: 'Arquivar objetivo' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Arquivar Almofada?')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Arquivar' }).click();
    await expect(page.getByText('Objetivo arquivado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/goals$/);
    await expect(goalCard('Almofada')).toHaveCount(0);
  });

  test('a viewer sees the goals and cannot change them', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto('/net-worth/goals');
    await expect(guest.getByRole('heading', { name: 'Objetivos', level: 1 })).toBeVisible();
    await expect(guest.getByRole('article', { name: 'Viagem ao Japão' })).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Adicionar objetivo' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: /^Editar / })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Alterar meses' })).toHaveCount(0);
    await expect(guest.getByRole('link', { name: 'Criar fundo de emergência' })).toHaveCount(0);
    await shoot(guest, '306-goals-viewer');
    for (const path of ['/net-worth/goals/new', '/net-worth/goals/new?kind=emergency_fund']) {
      await guest.goto(path);
      await expect(guest.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    }
    const id = (await sql<{ id: string }>("select id from goal where name = 'Viagem ao Japão'"))[0]!
      .id;
    await guest.goto(`/net-worth/goals/${id}/edit`);
    await expect(guest.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    expect(
      await callAction(guest.request, 'goals.ts', 'createGoalAction', [
        {
          kind: 'generic',
          name: 'Sneaky',
          targetAmount: null,
          targetDate: null,
          accountId: null,
          budgetLineId: null,
          monthlyContribution: null,
        },
      ]),
    ).toContain('"code":"forbidden"');
    expect(await callAction(guest.request, 'goals.ts', 'archiveGoalAction', [id])).toContain(
      '"code":"forbidden"',
    );
    await ctx.close();
  });

  test('the goals page follows the window when it narrows (no sideways scroll)', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/net-worth/goals');
    await expect(goalCard('Viagem ao Japão')).toBeVisible();
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(0);
    }
    await snap(page, '310-goals-320');
    await page.goto('/net-worth/goals/new');
    await expect(page.getByRole('heading', { name: 'Novo objetivo', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Nome', { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await snap(page, '311-goal-form-320');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // -------------------------------------------------------------------------------------------
  // Spreadsheet import: Património and Objetivos

  test('the import shows Património and Objetivos, suggests the account, and commits them', async () => {
    const firstMonth = cal.month(-12);
    const savings = (
      await sql<{ id: string; name: string }>(
        "select id, name from financial_account where name = 'Conta Poupança' and archived_at is null",
      )
    )[0]!;
    const workbook = await buildBudgetSheet({
      startDate: `01/${firstMonth.slice(5, 7)}/${firstMonth.slice(0, 4)}`,
      netWorthRows: {
        assets: [
          { name: 'Conta Poupança', tipo: 'Liquidez', months: Array(12).fill(250_000) },
          { name: 'Terreno Teste', tipo: 'Imóvel', months: Array(12).fill(4_000_000) },
          { name: 'Coleção Teste', tipo: 'Colecionáveis', months: Array(12).fill(90_000) },
        ],
        liabilities: [
          { name: 'Crédito Pessoal Teste', tipo: 'Empréstimo', months: Array(12).fill(500_000) },
        ],
      },
      extraGoals: [{ name: 'Fundo de emergência', target: null, saved: 0, contribution: 20_000 }],
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/net-worth');
    await page.getByRole('button', { name: 'Adicionar' }).click();
    await page.getByRole('menuitem', { name: 'Importar da folha de cálculo' }).click();
    await expect(page).toHaveURL(/\/import\/budget$/);
    await page.locator('#budget-import-file').setInputFiles({
      name: 'orcamento-anterior.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbook,
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rever o que vai ser importado' }),
    ).toBeFocused();

    // The counters and the warnings, worded from their codes.
    await expect(page.getByTestId('import-counters')).toContainText('3 ativos');
    await expect(page.getByTestId('import-counters')).toContainText('1 passivo');
    const warnings = page.getByRole('status').filter({ hasText: /\d avisos?/ });
    await expect(warnings).toContainText(
      'Tipo «Colecionáveis» de «Coleção Teste» não reconhecido: importado como «Outro».',
    );
    await expect(warnings).toContainText(
      '«Fundo de emergência» é o fundo de emergência: a meta da folha é ignorada e calculada a partir do orçamento.',
    );

    // The Património tab: kind, values, and the account suggestion.
    await page.getByRole('tab', { name: /^Património \(4\)/ }).click();
    const nw = page.getByRole('tabpanel', { name: /^Património/ });
    await expect(nw.getByRole('heading', { name: 'Ativos', level: 3 })).toBeVisible();
    await expect(nw.getByRole('heading', { name: 'Passivos', level: 3 })).toBeVisible();
    const savingsRow = nw.getByRole('listitem').filter({ hasText: 'Conta Poupança' });
    await expect(savingsRow.getByText('Corresponde à conta «Conta Poupança»')).toBeVisible();
    await expect(savingsRow).toContainText('12 valores');
    await expect(savingsRow).toContainText(eur(250_000));
    await expect(
      nw
        .getByRole('listitem')
        .filter({ hasText: 'Terreno Teste' })
        .getByText('Novo', { exact: true }),
    ).toBeVisible();
    await nw.getByRole('button', { name: /^Ver meses Conta Poupança/ }).click();
    await expect(savingsRow.locator('dd').first()).toHaveText(eur(250_000));
    await shoot(page, '320-import-net-worth');

    await page.getByRole('tab', { name: /^Objetivos \(\d+\)/ }).click();
    const goals = page.getByRole('tabpanel', { name: /^Objetivos/ });
    await expect(goals.getByText('Fundo de emergência', { exact: true }).first()).toBeVisible();
    await expect(goals.getByText(/^Meta calculada · /)).toBeVisible();
    await expect(goals.getByText(/Meta 3\s000,00\s€/)).toBeVisible();
    await expect(goals.getByText('Sem meta ·').first()).toBeVisible();
    await shoot(page, '321-import-goals');
    await expectAccessible(page);

    // Keyboard: the tab list moves through the new tabs too.
    await page.getByRole('tab', { name: /^Contas e grupos/ }).focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: /^Objetivos/ })).toBeFocused();
    await page.getByRole('tab', { name: /^Património/ }).click();
    await expectAccessible(page);

    // The same review at phone widths: nothing pushes the page sideways.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(0);
      // The tab list scrolls on its own: the selected tab is never left out of sight.
      for (const name of [/^Objetivos \(\d+\)/, /^Património \(4\)/, /^Rubricas/]) {
        const tab = page.getByRole('tab', { name });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(tab).toBeInViewport({ ratio: 1 });
      }
      await page.getByRole('tab', { name: /^Contas e grupos/ }).focus();
      await page.keyboard.press('End');
      await expect(page.getByRole('tab', { name: /^Objetivos/ })).toBeInViewport({ ratio: 1 });
      await page.getByRole('tab', { name: /^Património/ }).click();
    }
    await snap(page, '322-import-review-320');
    await page.setViewportSize({ width: 1280, height: 800 });

    // Options: include boxes, and the suggestion preselected for the account link.
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('heading', { name: 'Escolher o que criar' })).toBeFocused();
    const include = page.getByRole('checkbox', {
      name: /^Importar património \(3 ativos, 1 passivo\)/,
    });
    await expect(include).toBeChecked();
    await expect(page.getByRole('checkbox', { name: /^Importar objetivos \(\d+\)/ })).toBeChecked();
    const link = page.getByRole('combobox', { name: 'Ligar «Conta Poupança» a' });
    await expect(link).toHaveValue(savings.id);
    await expect(link.locator('option:checked')).toHaveText('Conta Poupança');
    // A record that did not exist is new: nothing says it keeps a link.
    await expect(page.getByText('Já existe — mantém a ligação atual')).toHaveCount(0);
    await expect(
      page.getByText('Uma linha ligada usa o saldo da conta', { exact: false }),
    ).toBeVisible();
    // Rows with no suggestion wait in a disclosure.
    await expect(page.getByRole('combobox', { name: 'Ligar «Terreno Teste» a' })).toBeHidden();
    await page.getByText('Outras linhas (3)', { exact: false }).click();
    await expect(page.getByRole('combobox', { name: 'Ligar «Terreno Teste» a' })).toBeVisible();
    await shoot(page, '323-import-options');
    await expectAccessible(page);
    // Turning Património off hides the choices and says what happens.
    await page.getByText(/^Importar património/).click();
    await expect(page.getByText('Nada do património será importado.')).toBeVisible();
    await expect(link).toHaveCount(0);
    await page.getByText(/^Importar património/).click();
    await expect(page.getByRole('combobox', { name: 'Ligar «Conta Poupança» a' })).toHaveValue(
      savings.id,
    );

    await page.getByRole('button', { name: 'Importar orçamento' }).click();
    await expect(page.getByText('Orçamento importado.')).toBeFocused();
    await expect(page.locator('dl').getByText('Ativos').locator('..')).toContainText('3 novos');
    await expect(page.locator('dl').getByText('Passivos').locator('..')).toContainText('1 novo');
    await expect(page.locator('dl').getByText('Objetivos').locator('..')).toContainText(
      /novos?|atualizados?/,
    );
    await shoot(page, '324-import-done');

    // What was imported is there: the assets (the linked one counted through its account) and goals.
    await page.getByRole('link', { name: 'Ver património' }).click();
    await expect(page).toHaveURL(/\/net-worth$/);
    await expect(page.getByRole('link', { name: /Terreno Teste/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Crédito Pessoal Teste/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Coleção Teste/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Conta Poupança/ }).first()).toBeVisible();
    const linked = await sql<{ account_id: string | null }>(
      "select account_id from asset where name = 'Conta Poupança' and not archived",
    );
    expect(linked[0]!.account_id).toBe(savings.id);
    const land = await sql<{ n: number }>(
      "select count(*)::int as n from asset_valuation v join asset a on a.id = v.asset_id where a.name = 'Terreno Teste'",
    );
    expect(land[0]!.n).toBe(12);
    await page.goto('/net-worth/goals');
    await expect(goalCard('Viagem')).toBeVisible();
    // The emergency fund created earlier was matched by kind, not duplicated.
    expect(
      (
        await sql(
          "select count(*)::int as n from goal where kind = 'emergency_fund' and not archived",
        )
      )[0]!.n,
    ).toBe(1);
  });

  test('a link can be turned off in the import, and the sheet values are kept', async () => {
    const start = cal.month(-24);
    const workbook = await buildBudgetSheet({
      startDate: `01/${start.slice(5, 7)}/${start.slice(0, 4)}`,
      netWorthRows: {
        assets: [{ name: 'Conta Principal', tipo: 'Liquidez', months: Array(12).fill(120_000) }],
      },
      noCredits: true,
    });
    const principal = (
      await sql<{ id: string }>(
        "select id from financial_account where name = 'Conta Principal' and archived_at is null",
      )
    )[0]!.id;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/import/budget');
    await page.locator('#budget-import-file').setInputFiles({
      name: 'orcamento-antigo.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbook,
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rever o que vai ser importado' }),
    ).toBeFocused();
    await page.getByRole('button', { name: 'Continuar' }).click();
    const link = page.getByRole('combobox', { name: 'Ligar «Conta Principal» a' });
    await expect(link).toHaveValue(principal);
    await link.selectOption({ label: 'Não ligar' });
    await page.getByRole('button', { name: 'Importar orçamento' }).click();
    await expect(page.getByText('Orçamento importado.')).toBeFocused();
    const rows = await sql<{ account_id: string | null; id: string }>(
      "select id, account_id from asset where name = 'Conta Principal' and not archived",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBeNull();
    const values = await sql<{ n: number }>(
      'select count(*)::int as n from asset_valuation where asset_id = $1',
      [rows[0]!.id],
    );
    expect(values[0]!.n).toBe(12);
  });

  test('an existing record keeps its link in the import unless the person changes it', async () => {
    const start = cal.month(-36);
    const savings = (
      await sql<{ id: string }>(
        "select id from financial_account where name = 'Conta Poupança' and archived_at is null",
      )
    )[0]!.id;
    const workbook = await buildBudgetSheet({
      startDate: `01/${start.slice(5, 7)}/${start.slice(0, 4)}`,
      netWorthRows: {
        assets: [
          { name: 'Conta Poupança', tipo: 'Liquidez', months: Array(12).fill(250_000) },
          // Exists, unlinked, and an account of that name exists: the suggestion is not applied.
          { name: 'Conta Principal', tipo: 'Liquidez', months: Array(12).fill(120_000) },
        ],
      },
      noCredits: true,
    });
    await page.goto('/import/budget');
    await page.locator('#budget-import-file').setInputFiles({
      name: 'orcamento-mais-antigo.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbook,
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(
      page.getByRole('heading', { name: 'Rever o que vai ser importado' }),
    ).toBeFocused();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('combobox', { name: 'Ligar «Conta Poupança» a' })).toHaveValue(
      savings,
    );
    const principal = page.getByRole('combobox', { name: 'Ligar «Conta Principal» a' });
    await expect(principal).toHaveValue('');
    await expect(page.getByText('Já existe — mantém a ligação atual')).toHaveCount(2);
    await expect(principal).toHaveAccessibleDescription(/Já existe — mantém a ligação atual/);
    await page.getByRole('button', { name: 'Importar orçamento' }).click();
    await expect(page.getByText('Orçamento importado.')).toBeFocused();
    const kept = await sql<{ name: string; account_id: string | null }>(
      "select name, account_id from asset where name in ('Conta Poupança', 'Conta Principal') and not archived order by name",
    );
    expect(kept.map((r) => [r.name, r.account_id === null])).toEqual([
      ['Conta Poupança', false],
      ['Conta Principal', true],
    ]);
  });

  test('Resumo shows a skeleton of its own layout while it loads', async () => {
    // Let the sidebar link prefetch its loading shell before navigation is slowed down.
    const prefetched = page.waitForResponse(
      (r) => /\/net-worth\?_rsc=/.test(r.url()) && r.status() === 200,
    );
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await prefetched;
    const slow = /_rsc=/;
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue().catch((error: Error) => {
        if (!/already handled/i.test(error.message)) throw error;
      });
    });
    await page
      .getByRole('complementary')
      .getByRole('link', { name: /^Património/ })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'A carregar…' })).toBeAttached();
    await shoot(page, '219-nw-loading');
    await expect(page.getByRole('heading', { name: 'Património', level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    await page.unroute(slow);
  });

  // Three tests, not one: each screen is checked in light and dark, and together they do not fit a
  // single test's budget on a slow CI runner. The URLs are read lazily: earlier tests set them.
  const netWorthScreens = (): Array<[string, string]> => [
    ['summary', '/net-worth'],
    ['asset detail', apartmentUrl],
    ['liability detail', mortgageUrl],
    ['asset form', '/net-worth/assets/new'],
    ['liability form', '/net-worth/liabilities/new'],
    ['asset edit', `${apartmentUrl}/edit`],
    ['goals', '/net-worth/goals'],
    ['goal form', '/net-worth/goals/new'],
    ['emergency fund form', '/net-worth/goals/new?kind=emergency_fund'],
  ];

  test('axe finds no serious or critical violations on the net worth screens', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const [name, url] of netWorthScreens()) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await expectAccessible(page).catch((error: Error) => {
        error.message = `${name}: ${error.message}`;
        throw error;
      });
    }
  });

  test('axe finds no serious or critical violations on the table view, open sheets and full schedule', async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/net-worth');
    await page.getByRole('button', { name: /Ver como tabela|Ver gráfico/ }).click();
    await expectAccessible(page);
    await page.getByRole('button', { name: /Ver como tabela|Ver gráfico/ }).click();
    await page.getByRole('button', { name: 'Recalcular um mês' }).click();
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await page.goto(mortgageUrl);
    await page.getByRole('button', { name: 'Ver plano completo (360 prestações)' }).click();
    await expectAccessible(page);
  });

  test('axe finds no serious or critical violations on the main net worth screens on a phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [, url] of netWorthScreens().slice(0, 3)) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await expectAccessible(page);
      await expectNoPageOverflow(page);
    }
  });

  test('the screens fit a 320px phone without sideways scrolling', async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [name, url] of [
      ['nw', '/net-worth'],
      ['asset', apartmentUrl],
      ['liability', mortgageUrl],
      ['liability-form', '/net-worth/liabilities/new'],
      ['home', '/'],
    ] as const) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      await expectNoPageOverflow(page);
      await snap(page, `220-${name}-320`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('nothing in the console or the CSP report went wrong', () => {
    expect(problems).toEqual([]);
  });
});
