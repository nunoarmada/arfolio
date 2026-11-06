import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import {
  PASSWORD,
  axeViolations,
  newOwnerContext,
  shoot,
  signInOwner,
  waitForSettledPage,
  watch,
} from './helpers';

const VIEWER = { email: 'vic@example.com' };
const RULE_NAME = 'Pingo E2E';
const NEEDLE = 'PINGO DOCE E2E';
const ZERO = '00000000-0000-4000-8000-000000000000';

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

const money = (currency: string) =>
  new Intl.NumberFormat('pt-PT', { style: 'currency', currency, useGrouping: 'always' });
/** Minor units as the app writes them in pt-PT ("5 000,00 €"). */
const eur = (cents: number): string => money('EUR').format(cents / 100);

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
  const res = await request.post('/transactions', {
    headers: {
      'Next-Action': id!,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    data: JSON.stringify(args),
  });
  return res.text();
}

async function today(): Promise<string> {
  const timezone = (
    await sql<{ timezone: string }>('select timezone from household_settings limit 1')
  )[0]!.timezone;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function axeBoth(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * Axe on one open overlay. A modal menu or dialog hides the rest of the page from assistive
 * technology on purpose, which a whole-page scan reports as `aria-hidden-focus`.
 */
async function axeWithin(page: Page, selector: string, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await waitForSettledPage(page);
    const result = await new AxeBuilder({ page })
      .include(selector)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const found = result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.help}`);
    expect(found, `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * Makes server actions fail at the network (as a dropped connection does). The app's service
 * worker answers requests before Playwright's `route` sees them, so `fetch` is replaced in the page.
 */
async function actionsFail(page: Page, on: boolean): Promise<void> {
  await page.evaluate((fail) => {
    const w = window as unknown as { __realFetch?: typeof fetch };
    w.__realFetch ??= window.fetch.bind(window);
    const real = w.__realFetch;
    window.fetch = fail
      ? (input, init) =>
          new Headers(init?.headers).has('next-action')
            ? Promise.reject(new TypeError('Failed to fetch'))
            : real(input, init)
      : real;
  }, on);
}

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

type Seeded = { accountId: string; groceries: string; leisure: string; rows: string[] };

test.describe('apply a rule to existing movements, and investment holdings', () => {
  test.describe.configure({ mode: 'serial' });

  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let seeded: Seeded;
  let holdingsAccount = '';
  let emptyInvestment = '';
  let checking = '';
  let asOf = '';

  const category = async (name: string): Promise<string> =>
    (await sql<{ id: string }>('select id from category where name = $1 limit 1', [name]))[0]!.id;

  const rowsState = async () =>
    sql<{ raw_description: string; category_id: string | null; categorised_by: string | null }>(
      `select raw_description, category_id, categorised_by from transaction
       where account_id = $1 order by raw_description`,
      [seeded.accountId],
    );
  const categorisedBy = async (): Promise<string[]> =>
    (await rowsState()).filter((r) => r.categorised_by === 'rule').map((r) => r.raw_description);

  async function account(name: string, type: string, currency = 'EUR'): Promise<string> {
    return (
      await sql<{ id: string }>(
        `insert into financial_account (household_id, name, type, currency, opening_balance_date)
         values ($1, $2, $3, $4, current_date) returning id`,
        [await householdId(), name, type, currency],
      )
    )[0]!.id;
  }

  async function txn(
    accountId: string,
    description: string,
    by: { category?: string; by?: 'user' | 'rule' } = {},
  ): Promise<string> {
    return (
      await sql<{ id: string }>(
        `insert into transaction (household_id, account_id, dedupe_hash, booking_date, amount,
           currency, status, raw_description, source, category_id, categorised_by)
         values ($1, $2, $3, current_date, -1000, 'EUR', 'booked', $4, 'manual', $5, $6)
         returning id`,
        [
          await householdId(),
          accountId,
          randomUUID(),
          description,
          by.category ?? null,
          by.by ?? null,
        ],
      )
    )[0]!.id;
  }

  async function position(
    accountId: string,
    day: string,
    p: {
      instrument: string;
      name: string;
      ticker: string;
      isin?: string;
      quantity: string;
      value: number;
      cost: number | null;
      pl: number | null;
      currency?: string;
    },
  ): Promise<void> {
    await sql(
      `insert into position_snapshot (household_id, account_id, as_of, instrument, name, quantity,
         price_minor, value_minor, currency, cost_minor, unrealized_pl_minor, ticker, isin)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        await householdId(),
        accountId,
        day,
        p.instrument,
        p.name,
        p.quantity,
        p.value,
        p.value,
        p.currency ?? 'EUR',
        p.cost,
        p.pl,
        p.ticker,
        p.isin ?? null,
      ],
    );
  }

  async function seedRules(): Promise<Seeded> {
    const groceries = await category('Supermercado');
    const leisure = await category('Restaurantes e cafés');
    const accountId = await account('Conta Regras E2E', 'checking');
    const rows = [
      await txn(accountId, `${NEEDLE} 1`),
      await txn(accountId, `${NEEDLE} 2`),
      await txn(accountId, `${NEEDLE} 3`),
      // Matches the rule but already has its category: counted as "already set".
      await txn(accountId, `${NEEDLE} 4`, { category: groceries, by: 'rule' }),
      // Categorised by hand: never touched.
      await txn(accountId, `${NEEDLE} 5`, { category: leisure, by: 'user' }),
    ];
    return { accountId, groceries, leisure, rows };
  }

  async function seedHoldings(): Promise<void> {
    asOf = addDays(await today(), -6);
    holdingsAccount = await account('Corretora E2E', 'investment');
    emptyInvestment = await account('Corretora vazia E2E', 'investment');
    checking = await account('Conta sem posições E2E', 'checking');
    const base = { currency: 'EUR' };
    await position(holdingsAccount, asOf, {
      ...base,
      instrument: 'IE00BK5BQT80',
      name: 'Vanguard FTSE All-World',
      ticker: 'VWCE',
      isin: 'IE00BK5BQT80',
      quantity: '12.5000000000',
      value: 500000,
      cost: 460000,
      pl: 40000,
    });
    await position(holdingsAccount, asOf, {
      ...base,
      instrument: 'LOSS',
      name: 'Ação Perdedora',
      ticker: 'LOSS',
      quantity: '100',
      value: 200000,
      cost: 250000,
      pl: -50000,
    });
    await position(holdingsAccount, asOf, {
      ...base,
      instrument: 'NOCOST',
      name: 'Posição sem custo',
      ticker: 'NOCOST',
      quantity: '3',
      value: 100000,
      cost: null,
      pl: null,
    });
    await position(holdingsAccount, asOf, {
      ...base,
      instrument: 'FLAT',
      name: 'Posição estável',
      ticker: 'FLAT',
      quantity: '7',
      value: 50000,
      cost: 50000,
      pl: 0,
    });
    for (let i = 1; i <= 8; i += 1) {
      await position(holdingsAccount, asOf, {
        ...base,
        instrument: `S${i}`,
        name: `Pequena posição ${i}`,
        ticker: `S${i}`,
        quantity: '1',
        value: i * 1000,
        cost: i * 1000,
        pl: 0,
      });
    }
    await position(holdingsAccount, asOf, {
      instrument: 'USDX',
      name: 'Fundo em dólares',
      ticker: 'USDX',
      quantity: '2',
      value: 30000,
      cost: null,
      pl: null,
      currency: 'USD',
    });
  }

  let startedAt = new Date();

  async function clean(): Promise<void> {
    // The audit rows this spec's rule actions wrote (create, update, delete, apply) are shared
    // state: other specs read the household's activity list and expect it empty.
    await sql(`delete from audit_log where action like 'rule.%' and created_at >= $1`, [startedAt]);
    await sql(`delete from undo_token where kind = 'rule_application'`);
    await sql(`delete from rule where name = $1`, [RULE_NAME]);
    await sql(`delete from financial_account where name like '% E2E'`);
  }

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    startedAt = new Date(Date.now() - 1_000);
    await clean();
    seeded = await seedRules();
    await seedHoldings();
  });
  test.afterAll(async () => {
    await clean();
    await context.close();
  });
  test.afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  const ruleRow = (p: Page = page): Locator =>
    p.getByRole('listitem').filter({ hasText: RULE_NAME });
  const moreButton = (p: Page = page): Locator =>
    p.getByRole('button', { name: `Mais ações para a regra ${RULE_NAME}` });
  const applyDialog = (): Locator =>
    page.getByRole('alertdialog', { name: 'Aplicar a regra a movimentos existentes?' });

  async function openApply(): Promise<void> {
    await moreButton().click();
    await page.getByRole('menuitem', { name: /Aplicar a movimentos existentes/ }).click();
  }

  // ---------------------------------------------------------------------------------------
  // Rules

  test('creating a rule offers to apply it when existing movements match, and Aplicar + Anular work', async () => {
    await page.goto('/settings/rules');
    await page.getByRole('button', { name: 'Nova regra' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Nova regra' });
    await sheet.getByLabel('Nome da regra').fill(RULE_NAME);
    await sheet.getByLabel('A descrição contém').fill(NEEDLE);
    await sheet.getByRole('button', { name: 'Escolher categoria' }).click();
    await page
      .getByRole('dialog', { name: 'Escolher categoria' })
      .getByRole('button', { name: 'Supermercado' })
      .click();
    await sheet.getByRole('button', { name: 'Guardar regra' }).click();

    // 3 rows would change (the 4th is already in the category, the 5th is the user's).
    await expect(
      page.getByText('Regra criada. 3 movimentos existentes correspondem.'),
    ).toBeVisible();
    await shoot(page, 'H1-rule-offer-toast');
    expect(await categorisedBy()).toEqual([`${NEEDLE} 4`]);

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(page.getByText('3 movimentos categorizados como Supermercado')).toBeVisible();
    await expect.poll(async () => (await categorisedBy()).length).toBe(4);
    await shoot(page, 'H2-rule-applied-toast');

    await page.getByRole('button', { name: 'Anular', exact: true }).click();
    await expect(page.getByText('Alteração anulada', { exact: true })).toBeVisible();
    await expect.poll(async () => await categorisedBy()).toEqual([`${NEEDLE} 4`]);
    const user = (await rowsState()).find((r) => r.raw_description === `${NEEDLE} 5`);
    expect(user).toMatchObject({ category_id: seeded.leisure, categorised_by: 'user' });
  });

  test('the row has Switch, up and down and a ⋯ menu in place of edit and delete', async () => {
    await page.goto('/settings/rules');
    const row = ruleRow();
    await expect(row.getByRole('switch')).toBeVisible();
    await expect(row.getByRole('button', { name: `Subir a regra ${RULE_NAME}` })).toBeVisible();
    await expect(row.getByRole('button', { name: `Descer a regra ${RULE_NAME}` })).toBeVisible();
    await expect(row.getByRole('button', { name: `Editar a regra ${RULE_NAME}` })).toHaveCount(0);
    await moreButton().click();
    const items = page.getByRole('menuitem');
    await expect(items).toHaveText([/Aplicar a movimentos existentes/, 'Editar', 'Eliminar']);
    await shoot(page, 'H3-rule-menu');
    await axeWithin(page, '[role=menu]', 'rules row menu');
    await page.keyboard.press('Escape');
    await expect(moreButton()).toBeFocused();
    await axeBoth(page, 'rules page');
    await expectNoOverflowAt320(page, 'rules page');
  });

  test('the apply dialog shows the preview first; confirming categorises, Anular keeps what changed since', async () => {
    await page.goto('/settings/rules');
    await openApply();
    const dialog = applyDialog();
    await expect(dialog.getByText('Vai categorizar 3 movimentos como Supermercado.')).toBeVisible();
    await expect(dialog.getByText('1 movimento já está nesta categoria.')).toBeVisible();
    await expect(dialog.getByText(/Pode anular durante 15 minutos/)).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Categorizar 3 movimentos' });
    await expect(confirm).toBeFocused();
    await shoot(page, 'H4-apply-dialog', dialog);
    await axeWithin(page, '[role=alertdialog]', 'apply dialog');
    await confirm.click();

    await expect(dialog).toBeHidden();
    await expect(moreButton()).toBeFocused();
    await expect(page.getByText('3 movimentos categorizados como Supermercado')).toBeVisible();
    expect(await categorisedBy()).toHaveLength(4);
    // Rows really move to the category in the movements list.
    await page.goto(`/accounts/${seeded.accountId}`);
    await expect(
      page.getByRole('button', { name: new RegExp(`${NEEDLE} 1.*Supermercado`) }),
    ).toBeVisible();

    // A row the person changes afterwards is kept when they undo: reset, apply again, change one.
    await page.goto('/settings/rules');
    await sql(
      `update transaction set category_id = null, categorised_by = null
       where account_id = $1 and raw_description in ($2, $3, $4)`,
      [seeded.accountId, `${NEEDLE} 1`, `${NEEDLE} 2`, `${NEEDLE} 3`],
    );
    await openApply();
    await expect(dialog.getByText('Vai categorizar 3 movimentos como Supermercado.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Categorizar 3 movimentos' }).click();
    await expect(page.getByText('3 movimentos categorizados como Supermercado')).toBeVisible();
    await sql('update transaction set category_id = null where id = $1', [seeded.rows[1]]);
    await page.getByRole('button', { name: 'Anular', exact: true }).click();
    await expect(
      page.getByText('Alteração anulada. 1 movimento alterado entretanto foi mantido.'),
    ).toBeVisible();
    await expect.poll(async () => await categorisedBy()).toEqual([`${NEEDLE} 2`, `${NEEDLE} 4`]);
    await shoot(page, 'H5-undo-partial');
  });

  test('with nothing left to change the dialog says so and only offers Fechar', async () => {
    await page.goto('/settings/rules');
    await sql(
      `update transaction set category_id = $2, categorised_by = 'rule'
       where account_id = $1 and raw_description like $3 and categorised_by is distinct from 'user'`,
      [seeded.accountId, seeded.groceries, `${NEEDLE}%`],
    );
    await openApply();
    const dialog = applyDialog();
    await expect(dialog.getByText('Não há movimentos para alterar.')).toBeVisible();
    await expect(
      dialog.getByText('Os 4 movimentos que correspondem já estão em Supermercado.'),
    ).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Fechar' });
    await expect(close).toBeFocused();
    await expect(dialog.getByRole('button', { name: /Categorizar/ })).toHaveCount(0);
    await shoot(page, 'H6-apply-none', dialog);
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(moreButton()).toBeFocused();
  });

  test('errors stay in the dialog: preview failure with retry, and a failed apply', async () => {
    await sql(
      `update transaction set category_id = null, categorised_by = null
       where account_id = $1 and raw_description = $2`,
      [seeded.accountId, `${NEEDLE} 1`],
    );
    await page.goto('/settings/rules');
    await actionsFail(page, true);
    await openApply();
    const dialog = applyDialog();
    await expect(dialog.getByRole('alert')).toContainText(
      'Não foi possível verificar os movimentos. Tente novamente.',
    );
    await expect(dialog.getByRole('button', { name: /Categorizar/ })).toHaveCount(0);
    await shoot(page, 'H7-apply-preview-error', dialog);
    await actionsFail(page, false);
    await dialog.getByRole('button', { name: 'Tentar novamente' }).click();
    const confirm = dialog.getByRole('button', { name: 'Categorizar 1 movimento' });
    await expect(confirm).toBeVisible();

    await actionsFail(page, true);
    await confirm.click();
    await expect(dialog.getByRole('alert')).toContainText(
      'Não foi possível aplicar a regra. Nada foi alterado. Tente novamente.',
    );
    await expect(confirm).toBeEnabled();
    expect((await rowsState()).find((r) => r.raw_description === `${NEEDLE} 1`)?.category_id).toBe(
      null,
    );
    await shoot(page, 'H8-apply-error', dialog);
    await actionsFail(page, false);
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a turned-off rule cannot be applied from the menu', async () => {
    await page.goto('/settings/rules');
    await ruleRow().getByRole('switch').click();
    await expect(ruleRow().getByRole('switch')).not.toBeChecked();
    await moreButton().click();
    const item = page.getByRole('menuitem', { name: /Aplicar a movimentos existentes/ });
    await expect(item).toHaveAttribute('aria-disabled', 'true');
    await expect(item).toHaveAttribute('aria-describedby', /.+/);
    await page.keyboard.press('ArrowDown');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Editar' })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(item).toContainText('Ligue a regra para a aplicar');
    await shoot(page, 'H9-menu-rule-off');
    await page.keyboard.press('Escape');
    await ruleRow().getByRole('switch').click();
    await expect(ruleRow().getByRole('switch')).toBeChecked();
  });

  test('editing a rule only offers when the condition or category changed', async () => {
    await page.goto('/settings/rules');
    // Back to a state where something would change.
    await sql(
      `update transaction set category_id = null, categorised_by = null
       where account_id = $1 and raw_description = $2`,
      [seeded.accountId, `${NEEDLE} 2`],
    );
    // Only the name changes: plain toast, no offer.
    await moreButton().click();
    await page.getByRole('menuitem', { name: 'Editar' }).click();
    const sheet = page.getByRole('dialog', { name: 'Editar regra' });
    await sheet.getByLabel('Nome da regra').fill(RULE_NAME);
    await sheet.getByRole('button', { name: 'Guardar regra' }).click();
    await expect(page.getByText('Regra guardada', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar', exact: true })).toHaveCount(0);

    // The condition changes: offer.
    await moreButton().click();
    await page.getByRole('menuitem', { name: 'Editar' }).click();
    await sheet.getByLabel('A descrição contém').fill(`${NEEDLE} 1`);
    await sheet.getByRole('button', { name: 'Guardar regra' }).click();
    await expect(
      page.getByText('Regra guardada. 1 movimento existente corresponde.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar', exact: true })).toBeVisible();
  });

  test('deleting still goes through the confirmation from the menu', async () => {
    await page.goto('/settings/rules');
    await moreButton().click();
    await page.getByRole('menuitem', { name: 'Eliminar' }).click();
    const dialog = page.getByRole('alertdialog', { name: `Eliminar a regra ${RULE_NAME}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(moreButton()).toBeFocused();
    await moreButton().click();
    await page.getByRole('menuitem', { name: 'Eliminar' }).click();
    await dialog.getByRole('button', { name: 'Eliminar regra' }).click();
    await expect(page.getByText('Regra eliminada')).toBeVisible();
    await expect(ruleRow()).toHaveCount(0);
    // Put the rule back for the viewer check.
    await sql(
      `insert into rule (household_id, name, priority, enabled, condition, category_id, created_by)
       values ($1, $2, 1000, true, $3, $4, 'e2e')`,
      [
        await householdId(),
        RULE_NAME,
        JSON.stringify({ descriptionContains: NEEDLE }),
        seeded.groceries,
      ],
    );
  });

  test('a viewer reads the rules but cannot apply, and the actions refuse them', async ({
    browser,
  }) => {
    const headers = { ...(test.info().project.use.extraHTTPHeaders ?? {}) };
    const ctx = await browser.newContext({ locale: 'pt-PT', extraHTTPHeaders: headers });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto('/settings/rules');
    await expect(ruleRow(guest)).toBeVisible();
    await expect(guest.getByRole('button', { name: /Mais ações para a regra/ })).toHaveCount(0);
    await expect(guest.getByRole('switch')).toHaveCount(0);
    await shoot(guest, 'H10-rules-viewer');
    expect(await callAction(guest.request, 'rules.ts', 'applyRuleAction', [ZERO])).toContain(
      '"code":"forbidden"',
    );
    expect(
      await callAction(guest.request, 'rules.ts', 'revertRuleApplicationAction', [ZERO]),
    ).toContain('"code":"forbidden"');

    // Holdings are readable by every role.
    await guest.goto(`/accounts/${holdingsAccount}`);
    await expect(guest.getByRole('region', { name: 'Investimentos' })).toBeVisible();
    await ctx.close();
  });

  // ---------------------------------------------------------------------------------------
  // Holdings

  const section = (p: Page = page): Locator => p.getByRole('region', { name: 'Investimentos' });

  test('desktop: the table lists positions by value with signed gains, "—" without cost and a stale note', async () => {
    await page.goto(`/accounts/${holdingsAccount}`);
    const holdings = section();
    await expect(holdings.getByRole('heading', { name: 'Investimentos', level: 2 })).toBeVisible();
    // The account balance hero comes first, then Investimentos, then the movements.
    const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings.indexOf('Investimentos')).toBeLessThan(headings.indexOf('Movimentos'));
    await expect(holdings).toContainText(eur(886000));
    await expect(holdings).toContainText('Valores de');
    await expect(holdings).toContainText('podem estar desatualizados');

    const table = holdings.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Ativo',
      'Qtd.',
      'Valor',
      'Ganho/perda',
      'Peso',
    ]);
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(10);
    // Largest first, fixed order.
    await expect(rows.nth(0)).toContainText('Vanguard FTSE All-World');
    await expect(rows.nth(0)).toContainText('VWCE · IE00BK5BQT80');
    await expect(rows.nth(1)).toContainText('Ação Perdedora');
    await expect(rows.nth(2)).toContainText('Posição sem custo');
    await expect(rows.nth(3)).toContainText('Posição estável');

    const gain = rows.nth(0);
    await expect(gain).toContainText(eur(500000));
    await expect(gain).toContainText('12,5');
    await expect(gain).toContainText(`Ganho +${eur(40000)}`);
    await expect(gain).toContainText(/\+8,7\s?%/);
    await expect(gain).toContainText(/56,4\s?%/);
    const loss = rows.nth(1);
    await expect(loss).toContainText(`Perda −${eur(50000)}`);
    await expect(loss).toContainText(/−20,0\s?%/);
    const none = rows.nth(2);
    await expect(none).toContainText('—');
    await expect(none).toContainText('Sem custo de aquisição');
    await expect(none).not.toContainText(/[+−]\d/);
    const flat = rows.nth(3);
    await expect(flat).not.toContainText('Ganho');
    await expect(flat).not.toContainText('Perda');
    await expect(flat).not.toContainText('+');
    await expect(holdings).toContainText('Exclui posições noutras moedas');
    await expect(table.locator('tfoot')).toContainText('Total');
    await expect(table.locator('tfoot')).toContainText(eur(886000));
    await expect(table).toHaveAccessibleName(/Investimentos, Valores de/);

    // Show all: the rest appears, the foreign position last, in its own currency, no weight.
    await holdings.getByRole('button', { name: 'Ver todas (13)' }).click();
    await expect(rows).toHaveCount(13);
    await expect(rows.nth(12)).toContainText('Fundo em dólares');
    await expect(rows.nth(12)).toContainText(money('USD').format(300));
    await expect(rows.nth(12)).toContainText('—');
    await expect(holdings.getByRole('button', { name: /Ver todas/ })).toHaveCount(0);
    await shoot(page, 'H11-holdings-table', holdings);
    await axeBoth(page, 'holdings table');
  });

  test('phone: two-line rows, name truncated with a title, 320px does not scroll sideways', async () => {
    await page.goto(`/accounts/${holdingsAccount}`);
    await page.setViewportSize({ width: 390, height: 844 });
    const holdings = section();
    const list = holdings.getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(10);
    const first = list.getByRole('listitem').first();
    await expect(first).toContainText('Vanguard FTSE All-World');
    await expect(first).toContainText(/VWCE · Qtd\. 12,5 · 56,4\s?%/);
    await expect(first).toContainText(eur(500000));
    await expect(first).toContainText(`Ganho +${eur(40000)}`);
    await expect(first.getByText('Vanguard FTSE All-World')).toHaveAttribute(
      'title',
      'Vanguard FTSE All-World',
    );
    await expect(list.getByRole('listitem').nth(2)).toContainText('Sem custo de aquisição');
    await expect(holdings.getByRole('table')).toBeHidden();
    // Every row meets the 56px floor.
    for (const item of await list.getByRole('listitem').all()) {
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(56);
    }
    await expect(holdings.getByRole('button', { name: 'Ver todas (13)' })).toBeVisible();
    await shoot(page, 'H12-holdings-list', holdings);
    await expectNoOverflowAt320(page, 'account page with holdings');
    await page.setViewportSize({ width: 320, height: 700 });
    await holdings.scrollIntoViewIfNeeded();
    // At 320px the gain moves under the meta line and nothing wraps or is cut.
    for (const item of await list.getByRole('listitem').all()) {
      const box = (await item.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
    const shots = process.env.E2E_SCREENSHOTS_DIR;
    if (shots) {
      mkdirSync(shots, { recursive: true });
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${shots}/H13-holdings-320-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await axeBoth(page, 'holdings list');
  });

  test('a snapshot from today is not stale', async () => {
    await sql(`update position_snapshot set as_of = $2 where account_id = $1`, [
      holdingsAccount,
      await today(),
    ]);
    await page.goto(`/accounts/${holdingsAccount}`);
    await expect(section()).toContainText('Valores de');
    await expect(section()).not.toContainText('podem estar desatualizados');
  });

  test('an investment account without positions shows the empty state; other accounts show nothing', async () => {
    await page.goto(`/accounts/${emptyInvestment}`);
    const holdings = section();
    await expect(holdings.getByRole('heading', { name: 'Ainda não há posições.' })).toBeVisible();
    await expect(holdings).toContainText('As posições aparecem aqui depois da próxima atualização');
    await shoot(page, 'H14-holdings-empty', holdings);
    await axeBoth(page, 'holdings empty');

    await page.goto(`/accounts/${checking}`);
    await expect(
      page.getByRole('heading', { name: 'Movimentos', level: 2, exact: true }),
    ).toBeVisible();
    await expect(section()).toHaveCount(0);
  });

  test('Trading 212 pies: holdings grouped by pie, then what is outside pies (desktop and phone)', async () => {
    const h = await householdId();
    const [bucket] = await sql<{ id: string }>(
      `insert into investment_bucket (household_id, account_id, provider, external_id, name)
       values ($1, $2, 'trading212', 'e2e-pie', 'Reforma E2E') returning id`,
      [h, holdingsAccount],
    );
    for (const [ticker, quantity, invested, value] of [
      ['VWCE', '10', 360000, 400000],
      ['LOSS', '100', 250000, 200000],
    ] as const) {
      await sql(
        `insert into investment_bucket_holding (bucket_id, household_id, account_id, as_of, ticker,
           quantity, invested_minor, value_minor, currency)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'EUR')`,
        [bucket!.id, h, holdingsAccount, await today(), ticker, quantity, invested, value],
      );
    }
    await page.goto(`/accounts/${holdingsAccount}`);
    const holdings = section();
    const table = holdings.getByRole('table');
    const pie = table.getByRole('rowheader', { name: 'Reforma E2E' });
    const outside = table.getByRole('rowheader', { name: 'Fora dos pies' });
    await expect(pie).toBeVisible();
    await expect(outside).toBeVisible();
    // The pie comes first with its own value and gain, then its instruments, largest first.
    const pieRow = table.getByRole('row').filter({ has: pie });
    await expect(pieRow).toContainText(eur(600000));
    await expect(pieRow).toContainText(`−${eur(10000)}`);
    const names = await table.getByRole('rowheader').allInnerTexts();
    const at = (text: string) => names.findIndex((n) => n.includes(text));
    expect(at('Reforma E2E')).toBeLessThan(at('Vanguard FTSE All-World'));
    expect(at('Vanguard FTSE All-World')).toBeLessThan(at('Ação Perdedora'));
    expect(at('Ação Perdedora')).toBeLessThan(at('Fora dos pies'));
    // VWCE is split: 10 units in the pie, the other 2,5 outside it.
    const vwceOutside = table.getByRole('row').filter({ hasText: 'Vanguard' }).nth(1);
    await expect(vwceOutside).toContainText('2,5');
    await expect(vwceOutside).toContainText(eur(100000));
    // Every instrument is shown when grouped: no "Ver todas".
    await expect(holdings.getByRole('button', { name: /Ver todas/ })).toHaveCount(0);
    await shoot(page, 'H15-holdings-pies-table', holdings);
    await axeBoth(page, 'holdings by pie table');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(holdings.getByRole('heading', { name: 'Reforma E2E', level: 3 })).toBeVisible();
    await expect(holdings.getByRole('heading', { name: 'Fora dos pies', level: 3 })).toBeVisible();
    await expect(
      holdings.getByRole('region', { name: 'Reforma E2E' }).getByRole('listitem'),
    ).toHaveCount(2);
    await shoot(page, 'H16-holdings-pies-list', holdings);
    await expectNoOverflowAt320(page, 'account page with holdings by pie');
    await axeBoth(page, 'holdings by pie list');
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
