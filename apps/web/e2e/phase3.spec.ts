import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
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

/** The `id` of the first row of a query that must find one. */
async function first(text: string, values: unknown[] = []): Promise<string> {
  const row = (await sql<{ id: string }>(text, values))[0];
  if (!row) throw new Error(`no row for: ${text}`);
  return row.id;
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

/** How close to the end of the month (household time zone) a run must not start. */
const MONTH_END_MARGIN_MINUTES = 15;

/**
 * The app reads the real clock, so the spec cannot pin it. It pins the month instead: a run that
 * would start within the margin before a month ends waits for the new month, so the calendar
 * taken below stays true for the whole run.
 */
async function waitOutMonthEnd(timezone: string): Promise<void> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const lastDay = new Date(Date.UTC(n('year'), n('month'), 0)).getUTCDate();
  const secondsIntoDay = n('hour') * 3600 + n('minute') * 60 + n('second');
  const left = 86_400 - secondsIntoDay;
  if (n('day') === lastDay && left <= MONTH_END_MARGIN_MINUTES * 60) {
    await new Promise((resolve) => setTimeout(resolve, (left + 5) * 1000));
  }
}

/** Today's date in the household time zone, and the month the fixture budget starts in. */
async function calendar() {
  const timezone = (
    await sql<{ timezone: string }>('select timezone from household_settings limit 1')
  )[0]!.timezone;
  await waitOutMonthEnd(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [yyyy, mm] = [get('year'), get('month')];
  const label = new Intl.DateTimeFormat('pt-PT', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${yyyy}-${mm}-01T00:00:00Z`));
  const last = new Date(Date.UTC(Number(yyyy), Number(mm), 0)).getUTCDate();
  return {
    month: `${yyyy}-${mm}`,
    first: `${yyyy}-${mm}-01`,
    last: `${yyyy}-${mm}-${String(last).padStart(2, '0')}`,
    startDate: `01/${mm}/${yyyy}`,
    label: label.charAt(0).toUpperCase() + label.slice(1),
    lower: label,
  };
}

/** Axe on the current page in light and dark. */
async function expectAccessible(page: Page): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(150);
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

const lineRow = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

test.describe.configure({ mode: 'serial' });

test.describe('phase 3: budget, transfer plan, subscriptions, budget import', () => {
  const problems: string[] = [];
  let browser: Browser;
  let page: Page;
  let cal: Awaited<ReturnType<typeof calendar>>;
  let hid = '';
  // What the budget should show for two lines, once the seeded movements are added to whatever
  // earlier specs left in the same categories this month (the date decides, so measure it).
  const exp = { market: 0, diversos: 0 };
  const percent = (actual: number, planned: number) => Math.round((actual * 100) / planned);

  test.beforeAll(async ({ browser: b }) => {
    // Room for waiting out a month end (see waitOutMonthEnd).
    test.setTimeout((MONTH_END_MARGIN_MINUTES + 2) * 60_000);
    browser = b;
    page = await (await newOwnerContext(b)).newPage();
    watch(page, problems);
    await signInOwner(page);
    cal = await calendar();
    hid = await householdId();
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  // -------------------------------------------------------------------------------------------
  // Navigation

  test('the phone has five tabs and Mais holds accounts and settings', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/more');
    const tabs = page.getByRole('navigation', { name: 'Principal' });
    for (const name of ['Início', 'Movimentos', 'Orçamento', 'Património', 'Mais']) {
      await expect(tabs.getByRole('link', { name })).toBeVisible();
    }
    await expect(tabs.getByRole('link')).toHaveCount(5);
    await expect(page.getByRole('heading', { name: 'Mais', level: 1 })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Mais' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: /Contas e ligações/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Definições/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Aspeto e idioma/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Terminar sessão' })).toBeVisible();
    await shoot(page, '100-more');
    await expectNoPageOverflow(page);

    for (const path of ['/accounts', '/connections', '/settings/household']) {
      await page.goto(path);
      await expect(tabs.getByRole('link', { name: 'Mais' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
    await page.goto('/budget');
    await expect(tabs.getByRole('link', { name: 'Orçamento' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    const side = page.getByRole('complementary');
    for (const name of ['Início', 'Movimentos', 'Orçamento', 'Património', 'Contas']) {
      await expect(side.getByRole('link', { name })).toBeVisible();
    }
    await expect(side.getByRole('link', { name: 'Orçamento' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // -------------------------------------------------------------------------------------------
  // Nothing exists yet

  test('without a budget every page says so and offers the next step', async () => {
    await page.goto('/budget');
    await expect(page.getByRole('heading', { name: 'Ainda não há orçamento' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Criar orçamento' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Importar folha de cálculo' })).toBeVisible();
    await shoot(page, '101-budget-none');

    await page.goto('/budget/year');
    await expect(page.getByRole('heading', { name: 'Ainda não há orçamento' })).toBeVisible();
    await page.goto('/budget/transfers');
    await expect(page.getByRole('heading', { name: 'Ainda não há orçamento' })).toBeVisible();

    await page.goto('/budget/subscriptions');
    await expect(
      page.getByRole('heading', { name: 'Ainda não há pagamentos recorrentes' }),
    ).toBeVisible();
    await expect(page.getByText(/lojas onde também faz muitas compras/)).toBeVisible();
    await shoot(page, '102-subscriptions-empty');

    await page.goto('/');
    await expect(page.getByText('Ainda não há orçamento para este mês.')).toBeVisible();
    // The block is the month's hero: spending so far, and the way to make a budget.
    const month = page.getByRole('region', { name: 'Este mês' });
    await expect(month.getByText('Saídas este mês')).toBeVisible();
    await expect(month.getByRole('link', { name: 'Criar orçamento' })).toHaveAttribute(
      'href',
      '/budget/new',
    );
    await shoot(page, '103-home-no-budget');
  });

  test('a new budget offers import, and there is nothing to copy yet', async () => {
    await page.goto('/budget/new');
    await expect(page.getByRole('heading', { name: 'Novo orçamento', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Ano orçamental')).toBeVisible();
    await expect(page.getByRole('radio', { name: /Começar vazio/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /^Copiar/ })).toHaveCount(0);
    await shoot(page, '104-budget-new');
    await page.getByRole('radio', { name: /Importar da folha de cálculo/ }).check();
    await page.getByRole('button', { name: 'Continuar para a importação' }).click();
    await expect(page).toHaveURL(/\/import\/budget$/);
  });

  // -------------------------------------------------------------------------------------------
  // Import

  test('the import explains the export, and bad files are explained, not shown raw', async () => {
    await expect(page.getByRole('heading', { name: 'Importar orçamento', level: 1 })).toBeVisible();
    await expect(page.getByText(/Google Sheets: Ficheiro › Transferir/)).toBeVisible();
    await expect(page.getByText(/Excel: Ficheiro › Guardar como/)).toBeVisible();
    await expect(page.getByText(/Aceita .xlsx até 10 MB/)).toBeVisible();
    await shoot(page, '105-import-upload');

    const input = page.locator('#budget-import-file');
    await input.setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a workbook'),
    });
    await expect(page.getByText('Escolha um ficheiro .xlsx.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ler ficheiro' })).toBeDisabled();

    await input.setInputFiles({
      name: 'broken.xlsx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('this is not a workbook'),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Não foi possível ler' });
    await expect(alert).toContainText('.xlsx');
    await expect(alert).not.toContainText('Error');
    await shoot(page, '106-import-error');

    await input.setInputFiles({
      name: 'no-config.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildBudgetSheet({ omitSheets: ['Config'] }),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(page.getByText('Falta o separador «Config» na folha.')).toBeVisible();

    await input.setInputFiles({
      name: 'bad-cell.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildBudgetSheet({ patchBudget: [{ row: 4, col: 'D', value: 'abc' }] }),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(
      page.getByText(/Orçamento, célula D4: «abc» não é um valor válido\./),
    ).toBeVisible();
  });

  test('upload, review with warnings, options and result', async () => {
    const workbook = await buildBudgetSheet({
      startDate: cal.startDate,
      wrongLineTotal: true,
      badPeriodicity: true,
    });
    await page.locator('#budget-import-file').setInputFiles({
      name: 'orcamento.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: workbook,
    });
    await expect(page.getByTestId('chosen-file')).toHaveText('orcamento.xlsx');
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();

    await expect(
      page.getByRole('heading', { name: 'Rever o que vai ser importado' }),
    ).toBeFocused();
    const counters = page.getByTestId('import-counters');
    await expect(counters).toContainText('7 rubricas');
    await expect(counters).toContainText('3 contas (3 novas)');
    await expect(counters).toContainText('1 inativa ignorada');
    // Warnings are rendered from codes and parameters, in Portuguese, with money formatted.
    const warnings = page.getByRole('status').filter({ hasText: /\d avisos?/ });
    await expect(warnings).toContainText(/Despesas · Renda: o total na folha \(1,00\s€\)/);
    await expect(warnings).toContainText(
      'Subscrição «Clube F» ignorada: periodicidade «Bimestral» desconhecida.',
    );
    await shoot(page, '107-import-review');

    // Tabs: lines, accounts and groups, subscriptions.
    await expect(page.getByRole('tab', { name: /^Rubricas/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: 'Despesas', level: 3 })).toBeVisible();
    await page.getByRole('button', { name: /Ver meses Renda/ }).click();
    await expect(page.locator('dl dd', { hasText: eur(60000) }).first()).toBeVisible();
    await page.getByRole('tab', { name: /^Contas e grupos/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /^Subscrições/ })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('tab', { name: /^Contas e grupos/ }).click();
    const accountsPanel = page.getByRole('tabpanel', { name: /^Contas e grupos/ });
    await expect(accountsPanel.getByText('Conta Principal')).toBeVisible();
    await expect(accountsPanel.getByText('Nova').first()).toBeVisible();
    await shoot(page, '108-import-accounts');
    await page.getByRole('tab', { name: /^Subscrições/ }).click();
    const subsPanel = page.getByRole('tabpanel', { name: /^Subscrições/ });
    await expect(subsPanel.getByText('Streaming A')).toBeVisible();
    await expect(subsPanel.getByText(/As datas de renovação não são importadas/)).toBeVisible();
    await expect(subsPanel.getByText('Antigo E')).toHaveCount(0);
    await page.getByRole('tab', { name: /^Rubricas/ }).click();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('heading', { name: 'Escolher o que criar' })).toBeFocused();
    await expect(page.getByLabel(/Criar as 3 contas que faltam/)).toBeChecked();
    // No budget exists for that year: nothing to replace.
    await expect(page.getByLabel(/Substituir as rubricas/)).toHaveCount(0);
    await shoot(page, '109-import-options');
    await page.getByRole('button', { name: 'Importar orçamento' }).click();

    await expect(page.getByText('Orçamento importado.')).toBeVisible();
    await expect(page.getByText('Orçamento importado.')).toBeFocused();
    await expect(page.getByText('Rubricas importadas').locator('..')).toContainText('7');
    await expect(
      page.getByText('Foram criadas categorias com os nomes das rubricas'),
    ).toBeVisible();
    await expect(
      page.getByText(/escolha a conta principal em Definições › Orçamento/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Rever subscrições' })).toBeVisible();
    await shoot(page, '110-import-done');
    await page.getByRole('link', { name: 'Ver orçamento' }).click();
    await expect(page).toHaveURL(new RegExp(`/budget\\?month=${cal.month}`));
  });

  // -------------------------------------------------------------------------------------------
  // The month view

  test('booked movements fill the month view; pending ones stay apart', async () => {
    const account = await first(
      "select id from financial_account where household_id = $1 and name = 'Conta Principal'",
      [hid],
    );
    const linked = async (line: string): Promise<string> =>
      (
        await sql<{ category_id: string }>(
          `select blc.category_id from budget_line_category blc
             join budget_line bl on bl.id = blc.budget_line_id
            where bl.household_id = $1 and bl.name = $2`,
          [hid, line],
        )
      )[0]!.category_id;
    /** Booked spending in a category this month, positive, as the budget counts it. */
    const spent = async (category: string): Promise<number> =>
      -Number(
        (
          await sql<{ total: string }>(
            `select coalesce(sum(amount), 0)::text as total from "transaction"
              where household_id = $1 and category_id = $2 and status = 'booked'
                and currency = 'EUR' and transfer_group_id is null
                and booking_date between $3 and $4`,
            [hid, category, cal.first, cal.last],
          )
        )[0]!.total,
      );
    const [restaurants] = await sql<{ id: string }>(
      `select id from category where household_id = $1
        and name ~ 'Restaurantes e cafés|Restaurants and cafes' limit 1`,
      [hid],
    );
    const seed = async (
      description: string,
      cents: number,
      category: string | null,
      opts: { status?: 'booked' | 'pending'; currency?: string; day?: number } = {},
    ) => {
      const day = String(opts.day ?? 1).padStart(2, '0');
      await sql(
        `insert into "transaction" (household_id, account_id, dedupe_hash, booking_date, amount,
           currency, status, raw_description, counterparty, category_id, categorised_by, source,
           needs_review)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, 'manual', false)`,
        [
          hid,
          account,
          `e2e-p3-${randomUUID()}`,
          `${cal.month}-${day}`,
          cents,
          opts.currency ?? 'EUR',
          opts.status ?? 'booked',
          description,
          category,
          category ? 'user' : null,
        ],
      );
    };
    exp.market = (await spent(await linked('Supermercado'))) + 34000;
    exp.diversos = (await spent(await linked('Diversos'))) + 4500;
    await seed('Mercado Exemplo', -34000, await linked('Supermercado'));
    await seed('Mercado Exemplo (pendente)', -2310, await linked('Supermercado'), {
      status: 'pending',
      day: 2,
    });
    await seed('Mercado no estrangeiro', -1000, await linked('Supermercado'), { currency: 'USD' });
    await seed('Senhorio Exemplo', -60000, await linked('Renda'));
    await seed('Empresa A', 200000, await linked('Salário A'));
    await seed('Café Exemplo', -4500, restaurants!.id);
    await seed('Compra sem categoria', -1250, null);

    await page.goto(`/budget?month=${cal.month}`);
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('period-label')).toHaveText(cal.label);
    await expect(page.getByRole('navigation', { name: 'Secções do orçamento' })).toBeVisible();

    // Summary: a status sentence, what is left, the three figures.
    const summary = page.getByRole('region', { name: 'Resumo do mês' });
    await expect(summary.getByText(/Dentro do plano|Atenção|Acima do previsto/)).toBeVisible();
    await expect(summary).toContainText(/Restam|Acima/);
    await expect(summary).toContainText('Só movimentos contabilizados');
    await expect(summary.getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      / de .*, \d+%|acima/,
    );

    // A line: booked actual against planned, status word, pending apart.
    const market = lineRow(page, 'Supermercado');
    await expect(market).toContainText(eur(exp.market));
    await expect(market).toContainText(eur(40000));
    await expect(market).toContainText(
      exp.market <= 40000
        ? `Restam ${eur(40000 - exp.market)}`
        : `Acima ${eur(exp.market - 40000)}`,
    );
    await expect(market).toContainText(`Pendente ${eur(2310)}`);
    await expect(market.locator('[role=meter]')).toHaveAttribute(
      'aria-valuetext',
      exp.market <= 40000
        ? `${eur(exp.market)} de ${eur(40000)}, ${percent(exp.market, 40000)}%`
        : `${eur(exp.market)} de ${eur(40000)}, acima ${eur(exp.market - 40000)}`,
    );
    await expect(page.getByText(/noutras moedas que não entram nestes valores/)).toBeVisible();

    // Sections in sheet order with grouped lines.
    const headings = await page.locator('main h2').allTextContents();
    expect(headings.indexOf('Receitas')).toBeLessThan(headings.indexOf('Despesas'));
    expect(headings.indexOf('Despesas')).toBeLessThan(headings.indexOf('Poupança'));
    const food = page.getByRole('button', { name: /Alimentação/ });
    await expect(food).toHaveAttribute('aria-expanded', 'true');
    await food.click();
    await expect(food).toHaveAttribute('aria-expanded', 'false');
    await expect(market).toBeHidden();
    await food.click();
    await expect(market).toBeVisible();

    // Income above or at plan is good news, never an alarm.
    await expect(lineRow(page, 'Salário A')).toContainText('Recebido');

    // Unallocated and unbudgeted spending.
    // "Por atribuir" is a tile of the summary strip; the aside card is the transfer plan.
    await expect(summary).toContainText('Por atribuir');
    await expect(summary).toContainText('Previsto');
    const allocation = page.getByRole('region', { name: 'Plano de transferências' });
    await expect(allocation).toContainText('Escolher a conta principal');
    await expect(allocation.getByRole('link', { name: 'Ver plano' })).toBeVisible();
    const unbudgeted = page.getByRole('heading', { name: 'Fora do orçamento' });
    await expect(unbudgeted).toBeVisible();
    await expect(
      page.getByRole('link', { name: /Café Exemplo|Restaurantes/ }).first(),
    ).toBeVisible();
    await shoot(page, '111-month-view');
  });

  test('a line opens a sheet with its numbers, categories and the way to its movements', async () => {
    await lineRow(page, 'Supermercado').click();
    const sheet = page.getByRole('dialog', { name: 'Supermercado' });
    await expect(sheet).toContainText('Despesa');
    await expect(sheet).toContainText('Alimentação');
    await expect(sheet).toContainText('Cartão A');
    await expect(sheet.getByText('Pendente', { exact: true })).toBeVisible();
    await expect(sheet.getByText('não incluído')).toBeVisible();
    await expect(sheet).toContainText('1 movimento noutra moeda não está incluído');
    await expect(sheet.getByRole('link', { name: 'Editar rubrica' })).toBeVisible();
    await shoot(page, '112-line-sheet');
    const href = await sheet.getByRole('link', { name: 'Ver movimentos' }).getAttribute('href');
    expect(href).toContain('period=custom');
    expect(href).toContain(`from=${cal.first}`);
    await sheet.getByRole('link', { name: 'Ver movimentos' }).click();
    await expect(page).toHaveURL(/\/transactions\?period=custom/);
    await expect(page.getByRole('button', { name: /Mercado Exemplo/ }).first()).toBeVisible();
    await page.goBack();
    // Escape returns focus to the row that opened the sheet.
    await lineRow(page, 'Supermercado').click();
    await page.keyboard.press('Escape');
    await expect(lineRow(page, 'Supermercado')).toBeFocused();
  });

  test('unbudgeted spending can be linked to a line, which can then go over plan', async () => {
    await page.goto(`/budget?month=${cal.month}`);
    const link = page.getByRole('button', { name: /^Associar .* a uma rubrica$/ }).first();
    await link.click();
    const sheet = page.getByRole('dialog', { name: /^Associar/ });
    await sheet.getByLabel('Diversos').check();
    await sheet.getByRole('button', { name: 'Associar' }).click();
    await expect(page.getByText(/associada a Diversos/)).toBeVisible();
    // 45,00 against a plan of 20,00: icon, word, amount and a meter that says "acima".
    const diversos = lineRow(page, 'Diversos');
    await expect(diversos).toContainText(`Acima ${eur(exp.diversos - 2000)}`);
    await expect(diversos.locator('[role=meter]')).toHaveAttribute(
      'aria-valuetext',
      `${eur(exp.diversos)} de ${eur(2000)}, acima ${eur(exp.diversos - 2000)}`,
    );
    await shoot(page, '113-over-budget', diversos);
  });

  test('the month can be stepped, and a month without a budget says so', async () => {
    const next = page.getByRole('link', { name: /^Mês seguinte:/ });
    await next.click();
    await expect(page).toHaveURL(/month=/);
    await expect(page.getByText('Ainda não começou')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Este mês' })).toBeVisible();
    await shoot(page, '114-month-future');
    await page.getByRole('link', { name: 'Este mês' }).click();
    await expect(page.getByTestId('period-label')).toHaveText(cal.label);
    // Far outside the budget year: nothing covers it, and the way back is offered.
    await page.goto('/budget?month=2099-05');
    await expect(page.getByRole('heading', { name: /^Sem orçamento para/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Ir para/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Criar orçamento/ })).toBeVisible();
    await shoot(page, '115-month-uncovered');
  });

  // -------------------------------------------------------------------------------------------
  // The year grid

  test('the year grid is a real table with sticky headers and three views', async () => {
    await page.goto('/budget/year');
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    const region = page.getByRole('region', { name: /Orçamento .* valores previstos/ });
    await expect(region).toBeVisible();
    const table = page.getByRole('main').getByRole('table');
    await expect(table.getByRole('columnheader', { name: /Total/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /Média\/mês/ })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '% do total' })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'Total Receitas' })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'Total Despesas' })).toBeVisible();
    await expect(table.getByRole('rowheader', { name: 'Por atribuir' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: /mês atual/ })).toHaveCount(1);
    // Group and account moved under the line name (second line): no columns of their own.
    await expect(table.getByRole('columnheader', { name: 'Grupo' })).toHaveCount(0);
    await expect(table.getByRole('columnheader', { name: 'Conta' })).toHaveCount(0);
    await shoot(page, '116-year-planned');

    await page.locator('label', { hasText: /^Real$/ }).click();
    await expect(page).toHaveURL(/show=actual/);
    await expect(page.getByRole('region', { name: /valores reais/ })).toBeVisible();
    await expect(table).toContainText(eur(exp.market));
    // Over-plan cells carry text for assistive technology, not just a tint.
    await expect(table.getByText('acima do previsto').first()).toBeAttached();
    await shoot(page, '117-year-actual');

    await page.locator('label', { hasText: /^Diferença$/ }).click();
    await expect(page).toHaveURL(/show=diff/);
    await expect(page.getByText('Positivo = melhor que o previsto.')).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '% executado' })).toBeVisible();
    await shoot(page, '118-year-diff');
    await page.reload();
    await expect(page.getByLabel('Diferença', { exact: true })).toBeChecked();

    // A line name opens the twelve months of that line.
    await page.getByRole('button', { name: 'Renda' }).click();
    const sheet = page.getByRole('dialog', { name: 'Renda' });
    await expect(sheet.getByRole('table')).toContainText(cal.lower);
    await expect(sheet.getByRole('link', { name: 'Editar rubrica' })).toBeVisible();
    await shoot(page, '119-year-line-sheet');
    await page.keyboard.press('Escape');
  });

  test('on a phone only the table scrolls, and the first column stays put', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/budget/year');
      const region = page.getByRole('region', { name: /valores previstos/ });
      await expect(region).toBeVisible();
      await expectNoPageOverflow(page);
      const box = await region.evaluate((el) => ({
        scrolls: el.scrollWidth > el.clientWidth,
        left: el.scrollLeft,
      }));
      expect(box.scrolls).toBe(true);
      await region.evaluate((el) => (el.scrollLeft = 400));
      const header = page.getByRole('columnheader', { name: 'Rubrica' });
      const first = await header.boundingBox();
      const regionBox = (await region.boundingBox())!;
      expect(Math.abs(first!.x - regionBox.x)).toBeLessThan(3);
      if (width === 390) await shoot(page, '120-year-mobile');
    }
    for (const path of ['/budget', '/budget/transfers', '/budget/subscriptions']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoPageOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // -------------------------------------------------------------------------------------------
  // Settings

  test('settings: the main account and the alert percentages', async () => {
    await page.goto('/settings');
    await expect(page.getByRole('main').getByRole('link', { name: /^Orçamento/ })).toBeVisible();
    await page.goto('/settings/budget');
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Início do ano orçamental')).toBeVisible();
    // Stored default: 80 and 100.
    await expect(page.getByLabel('80%')).toBeChecked();
    await expect(page.getByLabel('100%')).toBeChecked();
    await expect(page.getByLabel('50%')).not.toBeChecked();
    // The status region exists before there is anything to say, so the message is announced.
    const status = page.locator('fieldset [aria-live="polite"]');
    await expect(status).toHaveCount(1);
    await expect(status).toBeEmpty();
    await page.getByText('80%', { exact: true }).click();
    await page.getByText('100%', { exact: true }).click();
    await expect(page.getByText('Alertas desligados')).toBeVisible();
    await expect(status).toContainText('Alertas desligados');
    await shoot(page, '121-settings-alerts-off');
    await page.getByText('80%', { exact: true }).click();
    await page.getByText('100%', { exact: true }).click();

    await page.getByLabel('Conta principal').selectOption({ label: 'Conta Principal' });
    await shoot(page, '122-settings-budget');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Conta principal')).toHaveValue(/.+/);
    await expect(page.getByLabel('80%')).toBeChecked();
    // The household page no longer carries the year start.
    await page.goto('/settings/household');
    await expect(page.getByLabel('Início do ano orçamental')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------------------------
  // Transfer plan and the line editor

  test('the transfer plan says what to move to each account', async () => {
    await page.goto(`/budget/transfers?month=${cal.month}`);
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('period-label')).toHaveText(cal.label);
    const answer = page.getByRole('region', { name: 'O que transferir este mês' });
    // Cartão A: 400 + 20; Conta Poupança: 200; the main account keeps the rest.
    await expect(answer).toContainText(eur(62000));
    await expect(answer).toContainText('para 2 contas');
    await expect(answer).toContainText(`Fica em Conta Principal:`);
    await expect(answer).toContainText(eur(223000));
    const moves = page.getByRole('region', { name: 'Transferir para' });
    await expect(moves.getByRole('listitem')).toHaveCount(2);
    await expect(moves.getByRole('listitem').first()).toContainText('Cartão A');
    await expect(moves.getByRole('listitem').first()).toContainText(eur(42000));
    await moves.getByRole('button', { name: /Para 2 rubricas/ }).click();
    await expect(moves).toContainText('Supermercado');
    await expect(moves).toContainText('Diversos');
    await shoot(page, '123-transfers');
  });

  test('editing a line saves everything or nothing', async () => {
    await page.goto(`/budget?month=${cal.month}`);
    await lineRow(page, 'Renda').click();
    await page
      .getByRole('dialog', { name: 'Renda' })
      .getByRole('link', { name: 'Editar rubrica' })
      .click();
    await expect(page).toHaveURL(/\/budget\/lines\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: 'Renda', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Nome')).toHaveValue('Renda');
    await expect(page.getByRole('radio', { name: 'Despesa' })).toBeChecked();
    await expect(page.getByLabel('Grupo', { exact: true })).toHaveValue(/.+/);
    await shoot(page, '124-line-editor');

    // Nothing is saved until "Guardar", and a failure leaves the line exactly as it was.
    await page.getByLabel('Nome').fill('Supermercado');
    await page.locator('[name="amount-0"]').fill('3000,00');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByLabel('Nome')).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByText('Já existe uma rubrica com este nome neste orçamento.', { exact: true }),
    ).toBeVisible();
    await shoot(page, '125-line-editor-error');
    const [stored] = await sql<{ amount: string }>(
      `select ba.amount::text from budget_amount ba
         join budget_line bl on bl.id = ba.budget_line_id
        where bl.household_id = $1 and bl.name = 'Renda' and ba.month_index = 1`,
      [hid],
    );
    expect(stored!.amount).toBe('60000');

    // Invalid amounts are named in a summary and next to the field.
    await page.getByLabel('Nome').fill('Renda');
    await page.locator('[name="amount-1"]').fill('abc');
    await page.getByRole('button', { name: 'Guardar' }).click();
    const summary = page.getByRole('alert').filter({ hasText: 'campo a corrigir' });
    await expect(summary).toBeVisible();
    await expect(page.getByText('Valor inválido. Use, por exemplo, 120,50.')).toHaveCount(2);
    await page.locator('[name="amount-1"]').fill('');
    await expect(page.getByText(/Total .* · Média\/mês/)).toBeVisible();

    // The helpers only edit the form.
    await page.getByRole('button', { name: 'Mesmo valor todos os meses' }).click();
    await page.getByLabel('Mesmo valor todos os meses', { exact: true }).fill('1000');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.locator('[name="amount-5"]')).toHaveValue('1000');
    await expect(page.getByText('Valor aplicado aos 12 meses')).toBeVisible();
    await page.getByRole('button', { name: 'Anular' }).click();
    await expect(page.locator('[name="amount-5"]')).toHaveValue('600');

    // The real change: the first month costs 3 000.
    await page.locator('[name="amount-0"]').fill('3000,00');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Rubrica guardada')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/budget\\?month=${cal.month}#line-`));
    await expect(lineRow(page, 'Renda')).toBeFocused();
    await expect(lineRow(page, 'Renda')).toContainText(eur(300000));
  });

  test('the category picker explains the one-line rule and keeps transfers out', async () => {
    await lineRow(page, 'Cinema').click();
    await page
      .getByRole('dialog', { name: 'Cinema' })
      .getByRole('link', { name: 'Editar rubrica' })
      .click();
    await expect(page.getByRole('heading', { name: 'Cinema', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Escolher categorias' }).click();
    const picker = page.getByRole('dialog', { name: 'Categorias da rubrica' });
    await expect(picker).toContainText('Cada categoria só pode pertencer a uma rubrica');
    await picker.getByLabel('Pesquisar categoria').fill('Supermercado');
    const taken = picker.getByRole('checkbox', { name: /Supermercado/ });
    await expect(taken).toHaveAttribute('aria-disabled', 'true');
    await expect(picker.getByText('Já está em «Supermercado»')).toBeVisible();
    await taken.dispatchEvent('click');
    await expect(
      picker.getByText('Para a mover, retire-a primeiro de «Supermercado».'),
    ).toBeVisible();
    await expect(taken).not.toBeChecked();
    await shoot(page, '126-category-picker');
    await picker.getByLabel('Pesquisar categoria').fill('Transfer');
    await expect(picker.getByText(/Nenhuma categoria corresponde/)).toBeVisible();
    await picker.getByRole('button', { name: 'Cancelar' }).click();
    // Leaving with edits asks first.
    await page.getByLabel('Nome').fill('Cinema e teatro');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    const leave = page.getByRole('alertdialog', { name: 'Sair sem guardar?' });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: 'Continuar a editar' }).click();
    await expect(page.getByLabel('Nome')).toHaveValue('Cinema e teatro');
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Sair sem guardar' }).click();
    await expect(page).toHaveURL(/\/budget(\?|$)/);
  });

  test('a new line can be added and deleted, and a deleted one is explained', async () => {
    await page.goto('/budget/lines/new?kind=saving');
    await expect(page.getByRole('heading', { name: 'Nova rubrica', level: 1 })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Poupança' })).toBeChecked();
    await page.getByLabel('Nome').fill('Férias');
    await expect(page.getByText('Sem conta, só contam as categorias associadas.')).toBeVisible();
    await page.getByLabel('Conta', { exact: true }).selectOption({ label: 'Conta Poupança' });
    await page.getByRole('button', { name: 'Mesmo valor todos os meses' }).click();
    await page.getByLabel('Mesmo valor todos os meses', { exact: true }).fill('75');
    await page.getByRole('button', { name: 'Aplicar' }).click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Rubrica guardada')).toBeVisible();
    await expect(lineRow(page, 'Férias')).toContainText(eur(7500));
    await shoot(page, '127-line-added');

    await lineRow(page, 'Férias').click();
    await page
      .getByRole('dialog', { name: 'Férias' })
      .getByRole('link', { name: 'Editar rubrica' })
      .click();
    await page.getByRole('button', { name: 'Eliminar rubrica' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Eliminar «Férias»?' });
    await expect(dialog).toContainText('Os movimentos não são alterados.');
    await dialog.getByRole('button', { name: 'Eliminar', exact: true }).click();
    await expect(page.getByText('Rubrica eliminada')).toBeVisible();
    await expect(lineRow(page, 'Férias')).toHaveCount(0);

    await page.goto('/budget/lines/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Esta rubrica já não existe.' })).toBeVisible();
    await shoot(page, '128-line-missing');
  });

  test('the transfer plan flags a main account that cannot cover the month', async () => {
    await page.goto(`/budget/transfers?month=${cal.month}`);
    const answer = page.getByRole('region', { name: 'O que transferir este mês' });
    // Renda is now 3 000: income 3 500 - own payments 3 050 - transfers 620 = -170.
    await expect(answer).toContainText(
      `Faltam ${eur(17000)} em Conta Principal para cobrir o plano de`,
    );
    await expect(answer).toContainText('é maior do que as receitas que lá entram');
    await expect(answer.getByRole('link', { name: /^Ver orçamento de/ })).toBeVisible();
    await expect(page.getByText('em falta').first()).toBeVisible();
    await shoot(page, '129-transfers-negative');
    await page.goto(`/budget?month=${cal.month}`);
    await expect(page.getByRole('region', { name: 'Plano de transferências' })).toContainText(
      `Faltam ${eur(17000)} na conta principal`,
    );
  });

  // -------------------------------------------------------------------------------------------
  // Subscriptions

  test('subscriptions: confirm, dismiss, undo, declare and edit', async () => {
    const account = await first(
      "select id from financial_account where household_id = $1 and name = 'Conta Principal'",
      [hid],
    );
    const detect = (name: string, cents: number, cadence: string, key: string) =>
      sql(
        `insert into recurring (household_id, account_id, merchant_key, name, amount, currency,
           cadence, next_expected_on, last_seen_on, status, source)
         values ($1, $2, $3, $4, $5, 'EUR', $6, current_date + 6, current_date - 24, 'detected', 'detected')`,
        [hid, account, `d:${key}`, name, cents, cadence],
      );
    await detect('Plataforma de vídeo', -1299, 'monthly', 'video');
    await detect('Clube de leitura', -4800, 'quarterly', 'leitura');
    await sql(
      `insert into recurring (household_id, merchant_key, name, amount, currency, cadence,
         next_expected_on, last_seen_on, status, source)
       values ($1, 'd:antigo', 'Revista parada', -990, 'EUR', 'monthly',
         current_date - 30, current_date - 60, 'confirmed', 'declared')`,
      [hid],
    );

    await page.goto('/budget/subscriptions');
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Custo mensal' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Por confirmar (2)' })).toBeVisible();
    await expect(page.getByText(/lojas onde também faz muitas outras compras/)).toBeVisible();
    await expect(page.getByText('A deteção corre uma vez por dia.')).toBeVisible();
    // Imported items with a yearly cadence show their monthly share; the overdue one warns.
    await expect(page.getByRole('button', { name: /Seguro B/ })).toContainText(
      `≈ ${eur(2000)}/mês`,
    );
    await expect(page.getByRole('button', { name: /Revista parada/ })).toContainText(
      'Sem pagamento desde',
    );
    await expect(page.getByRole('button', { name: /Streaming A/ })).toContainText('Importada');
    await shoot(page, '130-subscriptions');

    // Editing a detected item is a confirmation, and says so.
    await page.getByRole('button', { name: 'Mais ações para Clube de leitura' }).click();
    await page.getByRole('menuitem', { name: 'Editar Clube de leitura' }).click();
    const edit = page.getByRole('dialog', { name: 'Editar Clube de leitura' });
    await expect(edit.getByRole('button', { name: 'Guardar e confirmar' })).toBeVisible();
    await shoot(page, '131-recurring-sheet');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Mais ações para Clube de leitura' }),
    ).toBeFocused();

    // Confirm the first card: it folds away and focus moves to the next card.
    const cost = page.getByRole('region', { name: 'Custo mensal' });
    const before = await cost.textContent();
    await page.getByRole('button', { name: 'Confirmar Plataforma de vídeo' }).click();
    await expect(page.getByText('«Plataforma de vídeo» confirmada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirmar Clube de leitura' })).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Por confirmar (1)' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Plataforma de vídeo/ })).toBeVisible();
    await expect(cost).not.toHaveText(before!);
    // Undo puts it back among the detections.
    await page.getByRole('button', { name: 'Anular' }).click();
    await expect(page.getByRole('heading', { name: 'Por confirmar (2)' })).toBeVisible();

    // Dismiss, then undo.
    await page.getByRole('button', { name: 'Mais ações para Clube de leitura' }).click();
    await page.getByRole('menuitem', { name: 'Ignorar Clube de leitura' }).click();
    await expect(page.getByText('«Clube de leitura» ignorada')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Por confirmar (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Anular' }).click();
    await expect(page.getByRole('heading', { name: 'Por confirmar (2)' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Por confirmar (2)' })).toBeVisible();

    // Confirm both: the last one moves focus to the fixed list. The page runs on a slowed CPU
    // for this step: focus is placed after React has rendered the folded list, and a slow
    // machine (a busy CI runner, or screenshots being taken) is what used to leave it nowhere.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    try {
      await page.getByRole('button', { name: 'Confirmar Plataforma de vídeo' }).click();
      await page.getByRole('button', { name: 'Confirmar Clube de leitura' }).click();
      await expect(
        page.getByRole('heading', { name: 'Subscrições e pagamentos fixos' }),
      ).toBeFocused();
      await expect(page.getByRole('heading', { name: /^Por confirmar/ })).toHaveCount(0);
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
    }

    // Declare one by hand (what detection cannot find).
    await page.getByRole('button', { name: 'Adicionar pagamento recorrente' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar pagamento recorrente' });
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(sheet.getByText('Indique o nome.')).toBeVisible();
    await sheet.getByLabel('Nome').fill('Ginásio Exemplo');
    await sheet.getByLabel('Valor').fill('25');
    await sheet.getByLabel('Rubrica do orçamento').selectOption({ label: 'Cinema' });
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Pagamento recorrente adicionado')).toBeVisible();
    const row = page.getByRole('button', { name: /Ginásio Exemplo/ });
    await expect(row).toContainText('Próxima data desconhecida');
    await expect(row).toContainText('Declarada');
    await shoot(page, '132-subscriptions-after');
  });

  // -------------------------------------------------------------------------------------------
  // Alerts and notifications

  test('the alerts job runs and the bell shows what it found', async () => {
    const out = execFileSync('pnpm', ['exec', 'tsx', 'e2e/run-budget-alerts.ts'], {
      env: process.env,
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    });
    const result = JSON.parse(out.trim().split('\n').pop()!) as {
      lineAlerts: number;
      unallocatedAlerts: number;
    };
    expect(result.lineAlerts).toBeGreaterThanOrEqual(2);
    expect(result.unallocatedAlerts).toBe(1);

    // Two more kinds, one about an item that exists and one about an item that is gone.
    const recurringId = await first(
      "select id from recurring where household_id = $1 and name = 'Ginásio Exemplo'",
      [hid],
    );
    await sql(
      `insert into notification (household_id, user_id, kind, payload, dedupe_key) values
        ($1, null, 'recurring_missed', $2::jsonb, 'e2e-p3-missed'),
        ($1, null, 'recurring_price_change', $3::jsonb, 'e2e-p3-price'),
        ($1, null, 'recurring_missed', $4::jsonb, 'e2e-p3-gone')`,
      [
        hid,
        JSON.stringify({
          recurringId,
          name: 'Nome antigo',
          expectedOn: `${cal.month}-05`,
          amount: -2500,
          currency: 'EUR',
        }),
        JSON.stringify({
          recurringId,
          name: 'Nome antigo',
          previousAmount: -2500,
          amount: -3000,
          currency: 'EUR',
          date: `${cal.month}-04`,
        }),
        JSON.stringify({
          recurringId: randomUUID(),
          name: 'Apagado',
          expectedOn: `${cal.month}-06`,
          amount: -999,
          currency: 'EUR',
        }),
      ],
    );

    await page.goto('/');
    const bell = page
      .getByRole('complementary')
      .getByRole('button', { name: /^Notificações, \d+ por ler/ });
    await expect(bell).toBeVisible();
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notificações' });
    await expect(
      panel.getByText(
        new RegExp(`«Supermercado» chegou a 80% do previsto de ${cal.lower.split(' ')[0]}`),
      ),
    ).toBeVisible();
    await expect(
      panel.getByText(`${eur(exp.market)} de ${eur(40000)} quando o aviso foi criado.`),
    ).toBeVisible();
    await expect(panel.getByText(/«Diversos» passou o previsto de/)).toBeVisible();
    await expect(
      panel.getByText(`Acima ${eur(exp.diversos - 2000)}: ${eur(exp.diversos)} de ${eur(2000)}.`),
    ).toBeVisible();
    await expect(panel.getByText(/O plano de transferências de .* não fecha/)).toBeVisible();
    await expect(
      panel.getByText(`Faltam ${eur(17000)} na conta principal para cobrir o previsto.`),
    ).toBeVisible();
    // The current name, not the one in the payload.
    await expect(panel.getByText('Pagamento de Ginásio Exemplo não encontrado')).toBeVisible();
    await expect(panel.getByText(/Era esperado a .* \(25,00\s€\)/)).toBeVisible();
    await expect(panel.getByText('Ginásio Exemplo mudou de preço')).toBeVisible();
    await expect(panel.getByText(/De 25,00\s€ para 30,00\s€ a /)).toBeVisible();
    // A deleted target gets generic copy, never a raw kind or a name from the payload.
    await expect(panel.getByText('Pagamento recorrente não encontrado')).toBeVisible();
    await expect(panel.getByText('Apagado')).toHaveCount(0);
    await expect(panel.getByText(/recurring_|budget_/)).toHaveCount(0);
    await shoot(page, '133-notifications-budget');
    await expectAccessible(page);

    const view = panel.getByRole('link', { name: 'Ver rubrica' }).first();
    await view.click();
    await expect(page).toHaveURL(new RegExp(`/budget\\?month=${cal.month}#line-`));
    await expect(page.locator(':focus')).toHaveAttribute('id', /^line-/);
  });

  test('a notification link leaves focus on the line it opens, however slowly the panel closes', async () => {
    await page.goto('/');
    // The panel's exit animation is stretched so that the page a link opens has taken focus long
    // before the panel is gone. That is the order in which the bell used to take focus back.
    // (A constructed stylesheet: the page's CSP does not allow an injected <style>.)
    await page.evaluate(() => {
      const slow = new CSSStyleSheet();
      slow.replaceSync(
        '[role="dialog"][data-state="closed"] { animation-duration: 1500ms !important; }',
      );
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, slow];
    });
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Notificações/ })
      .click();
    const panel = page.getByRole('dialog', { name: 'Notificações' });
    await panel.getByRole('link', { name: 'Ver rubrica' }).first().click();
    await expect(page).toHaveURL(/\/budget\?month=.*#line-/);
    await expect(page.locator(':focus')).toHaveAttribute('id', /^line-/);
    await expect(panel).toHaveCount(0);
    await expect(page.locator(':focus')).toHaveAttribute('id', /^line-/);
  });

  test('the home page shows the compact budget card', async () => {
    await page.goto('/');
    const section = page.getByRole('region', {
      name: new RegExp(`^Orçamento de ${cal.lower.split(' ')[0]}`),
    });
    await expect(section).toBeVisible();
    await expect(section.getByRole('meter')).toBeVisible();
    await expect(section.getByRole('link', { name: 'Ver orçamento' })).toBeVisible();
    // Lines over their plan are listed by name with their status word.
    await expect(section).toContainText('Diversos');
    await expect(section).toContainText(`Acima ${eur(exp.diversos - 2000)}`);
    await shoot(page, '134-home-budget');
    await page.goto('/');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expectNoPageOverflow(page);
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  // -------------------------------------------------------------------------------------------
  // Several budgets

  test('budgets can be copied, renamed and archived, never deleted', async () => {
    await page.goto('/budget/new');
    // The next budget year is offered and copies the one before it.
    await page.getByLabel('Ano orçamental').selectOption({ index: 1 });
    await expect(page.getByRole('radio', { name: /^Copiar/ })).toBeChecked();
    await shoot(page, '135-budget-new-copy');
    await page.getByRole('button', { name: 'Criar orçamento' }).click();
    await expect(page.getByText('Orçamento criado')).toBeVisible();
    await expect(page).toHaveURL(/\/budget\?month=/);
    await expect(lineRow(page, 'Supermercado')).toBeVisible();

    await page.goto('/budget/all');
    await expect(page.getByRole('heading', { name: 'Orçamentos', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ativos' })).toBeVisible();
    const items = page.getByRole('list').filter({ hasText: 'Abrir' }).first().getByRole('listitem');
    await expect(items).toHaveCount(2);
    await shoot(page, '136-budgets-list');

    // Rename the newest one (the first in the list), then archive it.
    await page
      .getByRole('button', { name: /^Mudar o nome de/ })
      .first()
      .click();
    const sheet = page.getByRole('dialog', { name: 'Mudar o nome do orçamento' });
    await sheet.getByLabel('Nome').fill('Casa, ano seguinte');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Nome alterado')).toBeVisible();
    await expect(page.getByTitle('Casa, ano seguinte')).toBeVisible();
    await page.getByRole('button', { name: 'Arquivar Casa, ano seguinte' }).click();
    await expect(page.getByText('Orçamento arquivado')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Arquivados' })).toBeVisible();
    await shoot(page, '137-budgets-archived');
    // An archived budget opens on purpose, says so, and can be restored.
    await page.getByRole('link', { name: /^Abrir Casa, ano seguinte/ }).click();
    await expect(page.getByText('Este orçamento está arquivado.')).toBeVisible();
    await page.getByRole('button', { name: 'Reativar orçamento' }).click();
    await expect(page.getByText('Orçamento reativado')).toBeVisible();
    await page.goto('/budget/all');
    await expect(page.getByRole('heading', { name: 'Arquivados' })).toHaveCount(0);
    // The "current" budget is still the one that covers today.
    await page.goto('/budget');
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible();
    await expect(page.getByTestId('period-label')).toHaveText(cal.label);
    // Importing the same year again asks before replacing.
    await page.goto('/import/budget');
    await page.locator('#budget-import-file').setInputFiles({
      name: 'orcamento.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: await buildBudgetSheet({ startDate: cal.startDate }),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(page.getByText(/Já existe um orçamento para este ano/)).toBeVisible();
    await page.getByRole('button', { name: 'Continuar' }).click();
    const run = page.getByRole('button', { name: 'Importar orçamento' });
    await expect(run).toHaveAttribute('aria-disabled', 'true');
    await expect(
      page.getByText('Para importar, escolha substituir o orçamento existente.'),
    ).toBeVisible();
    await page.getByLabel(/^Substituir as rubricas de/).check();
    await shoot(page, '138-import-replace');
    await page.getByRole('button', { name: 'Importar orçamento' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Substituir' }).click();
    await expect(page.getByText('Orçamento importado.')).toBeVisible();
    await expect(page.getByText('As rubricas anteriores foram substituídas.')).toBeVisible();
    // Transactions were not touched: Supermercado still has its booked amount.
    await page.goto(`/budget?month=${cal.month}`);
    await expect(lineRow(page, 'Supermercado')).toContainText(eur(exp.market));
  });

  test('the budget shows a skeleton of its own layout while it loads', async () => {
    await page.goto('/');
    // Let the links finish prefetching their loading shells before navigation is slowed down.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_500);
    const slow = /_rsc=/;
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      // A request the page gave up on (it navigated on) cannot be continued any more.
      await route.continue().catch((error: Error) => {
        if (!/already handled/i.test(error.message)) throw error;
      });
    });
    await page
      .getByRole('complementary')
      .getByRole('link', { name: /^Orçamento/ })
      .click();
    // The skeleton only appears after 200ms, so quick loads never flash.
    await page.waitForTimeout(500);
    await expect(page.getByRole('status').filter({ hasText: 'A carregar…' })).toBeAttached();
    await shoot(page, '141-budget-loading');
    await expect(page.getByRole('heading', { name: 'Orçamento', level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    await page.unroute(slow);
  });

  // -------------------------------------------------------------------------------------------
  // A viewer reads everything and changes nothing

  test('a viewer sees the budget, with no way to change it', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto(`/budget?month=${cal.month}`);
    await expect(lineRow(guest, 'Supermercado')).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Adicionar rubrica' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /^Associar .* a uma rubrica$/ })).toHaveCount(0);
    await lineRow(guest, 'Supermercado').click();
    const sheet = guest.getByRole('dialog', { name: 'Supermercado' });
    await expect(sheet.getByRole('link', { name: 'Ver movimentos' })).toBeVisible();
    await expect(sheet.getByRole('link', { name: 'Editar rubrica' })).toHaveCount(0);
    await shoot(guest, '139-month-viewer');
    await guest.keyboard.press('Escape');

    await guest.goto('/budget/year');
    await expect(guest.getByRole('table')).toBeVisible();
    for (const name of ['Adicionar rubrica', 'Importar folha de cálculo', 'Novo orçamento']) {
      await expect(guest.getByRole('link', { name })).toHaveCount(0);
    }
    await guest.getByRole('button', { name: 'Renda' }).click();
    await expect(
      guest.getByRole('dialog', { name: 'Renda' }).getByRole('link', { name: 'Editar rubrica' }),
    ).toHaveCount(0);
    await guest.keyboard.press('Escape');

    await guest.goto('/budget/subscriptions');
    await expect(
      guest.getByRole('heading', { name: 'Subscrições e pagamentos fixos' }),
    ).toBeVisible();
    await expect(
      guest.getByRole('button', { name: /^Confirmar|^Ignorar|^Editar|^Mais ações/ }),
    ).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Adicionar pagamento recorrente' })).toHaveCount(
      0,
    );
    await expect(guest.getByRole('button', { name: /Streaming A/ })).toHaveCount(0);
    await shoot(guest, '140-subscriptions-viewer');

    await guest.goto('/budget/transfers');
    await expect(guest.getByRole('region', { name: 'O que transferir este mês' })).toBeVisible();

    await guest.goto('/budget/all');
    await expect(guest.getByRole('button', { name: /^Mudar o nome|^Arquivar/ })).toHaveCount(0);

    await guest.goto('/settings/budget');
    await expect(
      guest.getByText('Só os proprietários podem alterar estas definições.'),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Guardar' })).toHaveCount(0);
    await expect(guest.getByLabel('Conta principal')).toBeDisabled();

    // Pages that write are not there at all (a 404 page; the loading shell streams first).
    for (const path of ['/budget/new', '/budget/lines/new', '/import/budget']) {
      await guest.goto(path);
      await expect(guest.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    }
    await guest.goto('/');
    await expect(guest.getByRole('region', { name: /^Orçamento de/ })).toBeVisible();
    await ctx.close();
  });

  // -------------------------------------------------------------------------------------------
  // Accessibility of every new screen, light and dark

  test('axe finds no serious or critical violations on the new screens', async () => {
    const lineId = await first(
      `select bl.id from budget_line bl join budget b on b.id = bl.budget_id
        where bl.household_id = $1 and bl.name = 'Cinema' and b.name <> 'Casa, ano seguinte'
        order by b.start_month limit 1`,
      [hid],
    );
    const screens: Array<[string, string]> = [
      ['budget month', `/budget?month=${cal.month}`],
      ['budget year', '/budget/year'],
      ['line editor', `/budget/lines/${lineId}`],
      ['new budget', '/budget/new'],
      ['budgets list', '/budget/all'],
      ['transfers', `/budget/transfers?month=${cal.month}`],
      ['subscriptions', '/budget/subscriptions'],
      ['settings budget', '/settings/budget'],
      ['more', '/more'],
      ['import upload', '/import/budget'],
    ];
    for (const [name, url] of screens) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(100);
        expect(await axeViolations(page), `${name} (${scheme})`).toEqual([]);
      }
    }
    // Open states: the line sheet and the category picker.
    await page.goto(`/budget?month=${cal.month}`);
    await lineRow(page, 'Supermercado').click();
    await expect(page.getByRole('dialog', { name: 'Supermercado' })).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), `line sheet (${scheme})`).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
