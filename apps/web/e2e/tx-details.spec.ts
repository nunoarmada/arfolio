import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

/** A 2x2 white PNG: small, valid, and real image bytes for the logo route. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA0EAgH3AGHHAAAAAElFTkSuQmCC',
  'base64',
);
const IBAN = 'PT50000201231234567890154';

/** Runs SQL as the database owner (bypasses RLS): seeding and inspection only. */
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

test.describe('transaction details: merchant logo, friendly name and the details card', () => {
  test.describe.configure({ mode: 'serial' });

  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let household = '';
  let rich = '';

  async function clean(): Promise<void> {
    await sql(`delete from transaction where raw_description like '% E2E'`);
    await sql(
      `delete from merchant_logo where merchant_id in (select id from merchant where key like 'E2E %')`,
    );
    await sql(`delete from merchant where key like 'E2E %'`);
    await sql(`delete from financial_account where name like '% E2E'`);
  }

  async function merchant(
    key: string,
    name: string,
    logo: 'ok' | 'broken' | null,
  ): Promise<string> {
    const id = (
      await sql<{ id: string }>(
        `insert into merchant (household_id, key, display_name, domain, name_source) values ($1, $2, $3, $4, 'ai') returning id`,
        [household, key, name, `${key.slice(4).toLowerCase()}.example`],
      )
    )[0]!.id;
    if (logo) {
      await sql(
        `insert into merchant_logo (merchant_id, household_id, status, content_type, bytes)
         values ($1, $2, 'ok', 'image/png', $3)`,
        [id, household, logo === 'ok' ? PNG : Buffer.from('not an image at all')],
      );
    }
    return id;
  }

  async function txn(
    accountId: string,
    description: string,
    merchantId: string,
    extra: object = {},
  ) {
    const v = {
      amount: -1250,
      transaction_date: null as string | null,
      mcc: null as string | null,
      details: null as object | null,
      ...extra,
    };
    return (
      await sql<{ id: string }>(
        `insert into transaction (household_id, account_id, dedupe_hash, booking_date, transaction_date,
           amount, currency, status, raw_description, source, merchant_id, mcc, details)
         values ($1, $2, $3, current_date, $4, $5, 'EUR', 'booked', $6, 'connector', $7, $8, $9)
         returning id`,
        [
          household,
          accountId,
          randomUUID(),
          v.transaction_date,
          v.amount,
          description,
          merchantId,
          v.mcc,
          v.details ? JSON.stringify(v.details) : null,
        ],
      )
    )[0]!.id;
  }

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    await clean();
    household = (await sql<{ id: string }>('select id from organization limit 1'))[0]!.id;
    const account = (
      await sql<{ id: string }>(
        `insert into financial_account (household_id, name, type, currency, opening_balance_date)
         values ($1, 'Conta Detalhes E2E', 'checking', 'EUR', current_date) returning id`,
        [household],
      )
    )[0]!.id;
    const amazon = await merchant('E2E AMAZON', 'Amazon Tester', 'ok');
    const plain = await merchant('E2E PLAIN', 'Padaria Sem Logo', null);
    const broken = await merchant('E2E BROKEN', 'Loja Logo Partido', 'broken');
    rich = await txn(account, 'COMPRA 4321 AMAZON E2E', amazon, {
      transaction_date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      mcc: '5411',
      details: {
        location: { city: 'Lisboa', country: 'PT' },
        originalAmount: { amount: -1400, currency: 'USD' },
        exchangeRate: '0.9213',
        counterpartyAccount: { iban: IBAN, bic: 'BCOMPTPL' },
        reference: 'REF-E2E-77',
        remittance: ['Linha um', 'Linha dois'],
        bankCode: { code: 'PMNT' },
      },
    });
    await txn(account, 'PADARIA 11 E2E', plain);
    await txn(account, 'LOJA 22 E2E', broken);
  });
  test.afterAll(async () => {
    await clean();
    await context.close();
  });
  test.afterEach(async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('the list shows the friendly name and the logo only where a logo exists', async () => {
    await page.goto('/transactions?period=all');
    const amazon = page.getByRole('button', { name: /Amazon Tester/ });
    await expect(amazon).toBeVisible();
    await expect(amazon.locator('img')).toHaveCount(1);
    await expect
      .poll(async () =>
        amazon
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await expect(amazon.locator('img')).toHaveAttribute('alt', '');
    // No logo row: the category disc only, and the browser never asks for one.
    await expect(page.getByRole('button', { name: /Padaria Sem Logo/ }).locator('img')).toHaveCount(
      0,
    );
    // A broken image falls back to the category disc.
    await expect(
      page.getByRole('button', { name: /Loja Logo Partido/ }).locator('img'),
    ).toHaveCount(0);
    await shoot(page, 'TD1-list-logos');
  });

  test('search finds a movement by its friendly name', async () => {
    await page.goto('/transactions?period=all&q=amazon%20tester');
    await expect(page.getByRole('button', { name: /Amazon Tester/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Padaria Sem Logo/ })).toHaveCount(0);
  });

  test('the detail shows the default fields and keeps the technical ones behind "Mais detalhes"', async () => {
    await page.goto(`/transactions/${rich}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Amazon Tester' })).toBeVisible();
    const details = page.getByRole('region', { name: 'Detalhes' });
    await expect(details.getByText('Data da compra')).toBeVisible();
    await expect(details.getByText(/Contabilizado a /)).toBeVisible();
    await expect(details.getByText('amazon.example')).toBeVisible();
    await expect(details.getByText('Lisboa, Portugal')).toBeVisible();
    await expect(details.getByText('Valor original')).toBeVisible();
    await expect(details.getByText('1 USD = 0,9213 €')).toBeVisible();
    await expect(details.getByText('Para a conta')).toBeVisible();
    await expect(details.getByText('REF-E2E-77')).toBeVisible();
    // Technical fields start collapsed.
    const more = details.getByRole('button', { name: 'Mais detalhes' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(details.getByText('BIC/SWIFT')).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(details.getByText('Atividade do comerciante')).toBeVisible();
    await expect(details.getByText(/\(MCC 5411\)/)).toBeVisible();
    await expect(details.getByText('Linha dois')).toBeVisible();
    await expect(details.getByText('BCOMPTPL')).toBeVisible();
    await expect(details.getByText('COMPRA 4321 AMAZON E2E')).toBeVisible();
    await expect(details.getByText('Código da operação')).toBeVisible();
    await shoot(page, 'TD2-detail-expanded');
  });

  test('the IBAN is masked until revealed, and copy always takes the full number', async () => {
    await page.goto(`/transactions/${rich}`);
    const details = page.getByRole('region', { name: 'Detalhes' });
    await expect(details.getByText('PT50 •••• … 9015 4')).toBeVisible();
    await expect(details.getByText('0002 0123')).toHaveCount(0);
    const show = details.getByRole('button', { name: 'Mostrar IBAN completo' });
    await show.click();
    await expect(details.getByText('PT50 0002 0123 1234 5678 9015 4')).toBeVisible();
    await expect(details.getByRole('button', { name: 'Ocultar IBAN' })).toBeVisible();
    await details.getByRole('button', { name: 'Ocultar IBAN' }).click();
    await expect(details.getByText('PT50 •••• … 9015 4')).toBeVisible();
    // Copy works while masked and puts the unspaced IBAN on the clipboard.
    await details.getByRole('button', { name: 'Copiar IBAN' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'IBAN copiado' })).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(IBAN);
    await details.getByRole('button', { name: 'Copiar referência' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('REF-E2E-77');
  });

  test('a row with nothing extra shows no empty lines and still opens "Mais detalhes"', async () => {
    await page.goto('/transactions?period=all');
    await page.getByRole('button', { name: /Padaria Sem Logo/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Detalhe do movimento' });
    const details = sheet.getByRole('region', { name: 'Detalhes' });
    await expect(sheet.getByRole('heading', { level: 2, name: 'Padaria Sem Logo' })).toBeVisible();
    // The name is only in the header; the card adds the website.
    await expect(details.getByText('Padaria Sem Logo')).toHaveCount(0);
    await expect(details.getByText('plain.example')).toBeVisible();
    await expect(details.getByText('Local')).toHaveCount(0);
    await expect(details.getByText('Valor original')).toHaveCount(0);
    await expect(details.getByText('Para a conta')).toHaveCount(0);
    await expect(details.getByText('-', { exact: true })).toHaveCount(0);
    await details.getByRole('button', { name: 'Mais detalhes' }).click();
    await expect(details.getByText('PADARIA 11 E2E')).toBeVisible();
    await shoot(page, 'TD3-detail-sheet-plain');
  });

  test('the detail has no serious accessibility violations at phone width in both modes', async () => {
    await page.goto(`/transactions/${rich}`);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.getByRole('button', { name: 'Mais detalhes' }).click();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), scheme).toEqual([]);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
