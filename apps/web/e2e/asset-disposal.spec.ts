import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

/** Runs SQL as the database owner (bypasses RLS): cleanup only, never the app. */
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

const MONEY = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  useGrouping: 'always',
});
/** Minor units as the app writes them in pt-PT ("1 240,00 €"). */
const eur = (cents: number): string => MONEY.format(cents / 100);

/** `eur` as a regex source: accessible names collapse the non-breaking spaces. */
const eurSource = (cents: number): string => eur(cents).replace(/\s/g, '\\s');

/** The visible label of a radio card (the radio is visually hidden). */
const pickKind = (page: Page, label: string) =>
  page
    .locator('label')
    .filter({ has: page.getByRole('radio') })
    .getByText(label, { exact: true })
    .click();

const EARLIER = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
const SALE_DESCRIPTION = 'Venda da casa de Braga';
const HOUSE = 'Casa de Braga';
const MORTGAGE = 'Crédito habitação';

test.describe.configure({ mode: 'serial' });

// Selling an asset with a linked credit, the exited section, settling and undoing, deleting. Names
// are its own and everything is deleted at the end, since other projects count the household's
// assets and liabilities.
test.describe('asset disposal and linked credits', () => {
  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let houseId = '';
  let mortgageId = '';

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
  });

  test.afterAll(async () => {
    await sql('delete from liability where name = $1', [MORTGAGE]);
    await sql('delete from asset where name = $1', [HOUSE]);
    await sql('delete from transaction where raw_description = $1', [SALE_DESCRIPTION]);
    await context.close();
  });

  const settledHeading = (text: RegExp | string) =>
    page.getByRole('heading', { name: text, level: 2 });

  test('a house with a linked mortgage: the credit nests under it, with the equity', async () => {
    await page.goto('/net-worth/assets/new');
    await pickKind(page, 'Imóvel');
    await page.getByLabel('Nome', { exact: true }).fill(HOUSE);
    await page.getByLabel('Valor', { exact: true }).fill('250000');
    // Valued well before the sale: "last value before the sale" looks at earlier days only.
    await page.getByLabel('Data', { exact: true }).fill(EARLIER);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    houseId = new URL(page.url()).pathname.split('/').at(-1)!;

    await page.goto('/net-worth/liabilities/new');
    await pickKind(page, 'Hipoteca');
    await page.getByLabel('Nome', { exact: true }).fill(MORTGAGE);
    // Every kind but card offers the asset it financed, grouped by kind.
    const financed = page.getByLabel('Ativo financiado');
    await expect(financed.locator('optgroup[label="Imóveis"]')).toContainText(HOUSE);
    await financed.selectOption({ label: HOUSE });
    await page.getByLabel('Saldo em dívida').fill('180000');
    // Not on the day it will be settled, when a zero balance is recorded.
    await page.getByLabel('Data', { exact: true }).fill(EARLIER);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Passivo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/liabilities\/[0-9a-f-]{36}$/);
    mortgageId = new URL(page.url()).pathname.split('/').at(-1)!;
    // A card cannot be linked to an asset: the field goes away.
    await page.goto('/net-worth/liabilities/new');
    await pickKind(page, 'Cartão');
    await expect(page.getByLabel('Ativo financiado')).toHaveCount(0);

    await page.goto('/net-worth');
    const credit = page.getByTestId(`nw-credit-${mortgageId}`);
    await expect(credit).toContainText(MORTGAGE);
    await expect(credit).toContainText(`−${eur(18_000_000)}`);
    await expect(page.getByTestId(`nw-equity-${houseId}`)).toContainText('Capital próprio');
    await expect(page.getByTestId(`nw-equity-${houseId}`)).toContainText(eur(7_000_000));
    await expect(page.getByRole('list', { name: `Créditos de ${HOUSE}` })).toBeVisible();
    // Still under Passivos, tagged with the asset.
    await expect(page.getByTestId(`nw-item-${mortgageId}`).first()).toContainText(
      `Associado a ${HOUSE}`,
    );
    await shoot(page, 'disposal-nested', page.getByTestId(`nw-equity-${houseId}`));

    await page.goto(`/net-worth/assets/${houseId}`);
    const credits = page.getByRole('region', { name: 'Créditos ligados' });
    await expect(credits.getByRole('link', { name: new RegExp(MORTGAGE) })).toBeVisible();
    await expect(credits.getByTestId('asset-equity')).toContainText(eur(7_000_000));
    await expect(page.getByRole('button', { name: 'Atualizar valor' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Ações do ativo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Arquivar ativo' })).toHaveCount(0);
  });

  test('selling with a transaction: it is picked from a searchable list', async () => {
    // An incoming booked movement in the household's currency is what a sale can be linked to.
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Movimento manual' }).click();
    const manual = page.getByRole('dialog', { name: 'Movimento manual' });
    await manual.getByLabel('Conta', { exact: true }).selectOption({ label: 'Conta Corrente' });
    await manual.getByLabel('Entrada').check();
    await manual.getByLabel('Valor', { exact: true }).fill('262500');
    await manual.getByLabel('Descrição', { exact: true }).fill(SALE_DESCRIPTION);
    await manual.getByRole('button', { name: 'Guardar movimento' }).click();
    await expect(manual).toBeHidden();

    await page.goto(`/net-worth/assets/${houseId}`);
    await page.getByRole('button', { name: 'Vender' }).click();
    const sheet = page.getByRole('dialog', { name: 'Registar venda' });
    // With something to link, that is where it starts.
    await expect(sheet.getByRole('radio', { name: 'Ligar a um movimento' })).toBeChecked();
    await expect(sheet.getByLabel('Procurar movimentos')).toBeVisible();

    // Choosing nothing is explained, and the search takes focus.
    await sheet.getByRole('button', { name: 'Registar venda' }).click();
    await expect(sheet.getByText('Escolha um movimento ou registe a venda à mão.')).toBeVisible();
    await expect(sheet.getByLabel('Procurar movimentos')).toBeFocused();

    const list = sheet.getByRole('radiogroup', { name: 'Movimento da venda' });
    await sheet.getByLabel('Procurar movimentos').fill('zzz sem resultados');
    await expect(
      sheet.getByText('Nenhum movimento corresponde a «zzz sem resultados».'),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Limpar pesquisa' }).click();
    await sheet.getByLabel('Procurar movimentos').fill('venda da casa');
    await expect(list.getByRole('radio')).toHaveCount(1);
    await expect(sheet.getByRole('status').filter({ hasText: '1 movimento' })).toBeVisible();
    await list.getByRole('radio', { name: new RegExp(SALE_DESCRIPTION) }).check();
    await expect(sheet.getByText(/^Venda a /)).toContainText(
      `por ${eur(26_250_000)} · liquida 1 crédito`,
    );
    expect(await axeViolations(page)).toEqual([]);
    await shoot(page, 'disposal-sell-picker');

    // The mortgage stays open this time.
    await sheet.getByTestId(`settle-${mortgageId}`).getByRole('checkbox').uncheck();
    await sheet.getByRole('button', { name: 'Registar venda' }).click();
    await expect(page.getByText('Venda registada')).toBeVisible();
    const heading = settledHeading(new RegExp(`^Vendido a .* por ${eurSource(26_250_000)}$`));
    await expect(heading).toBeFocused();
    // Linked to the movement, not entered by hand.
    await expect(page.getByRole('link', { name: 'Ver movimento da venda' })).toHaveAttribute(
      'href',
      /^\/transactions\/[0-9a-f-]{36}$/,
    );
    await expect(page.getByText('Registado à mão.')).toHaveCount(0);
    await expect(page.getByText('Há 1 crédito associado por liquidar.')).toBeVisible();
    await shoot(page, 'disposal-sold-linked', heading);

    await page.getByRole('button', { name: 'Anular venda' }).click();
    await expect(page.getByText('Venda anulada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vender' })).toBeVisible();
  });

  test('selling by hand settles the mortgage, which is ticked from the start', async () => {
    await page.goto(`/net-worth/assets/${houseId}`);
    await page.getByRole('button', { name: 'Vender' }).click();
    const sheet = page.getByRole('dialog', { name: 'Registar venda' });
    await expect(sheet).toBeVisible();

    // Entering by hand works whatever the household's transactions are.
    await sheet.getByRole('radio', { name: 'Registar à mão' }).check();
    // Submitting without an amount says so, and nothing is sold.
    await sheet.getByRole('button', { name: 'Registar venda' }).click();
    await expect(sheet.getByText('Indique o valor.')).toBeVisible();
    await sheet.getByLabel('Valor da venda').fill('260000');

    const box = sheet.getByTestId(`settle-${mortgageId}`);
    await expect(box.getByRole('checkbox', { name: new RegExp(MORTGAGE) })).toBeChecked();
    await expect(box.getByLabel(`Liquidado a, ${MORTGAGE}`)).toHaveValue(
      await sheet.getByLabel('Data da venda').inputValue(),
    );
    await expect(sheet.getByText(`Venda a `)).toContainText(
      `por ${eur(26_000_000)} · liquida 1 crédito`,
    );
    expect(await axeViolations(page)).toEqual([]);
    await shoot(page, 'disposal-sell-sheet');

    // Unticking removes its date and says where the credit stays; ticking brings it back.
    await box.getByRole('checkbox').uncheck();
    await expect(box.getByLabel(`Liquidado a, ${MORTGAGE}`)).toHaveCount(0);
    await expect(box).toContainText('Fica em Passivos, associado a um ativo vendido.');
    await box.getByRole('checkbox').check();
    await expect(box.getByLabel(`Liquidado a, ${MORTGAGE}`)).toBeVisible();

    await sheet.getByRole('button', { name: 'Registar venda' }).click();
    await expect(page.getByText('Venda registada')).toBeVisible();
    await expect(sheet).toHaveCount(0);

    // The page is now the sold asset's, with focus on the new status heading.
    const heading = settledHeading(new RegExp(`^Vendido a .* por ${eurSource(26_000_000)}$`));
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByText('Registado à mão.')).toBeVisible();
    await expect(page.getByText('Último valor antes da venda')).toBeVisible();
    await expect(page.getByTestId('detail-value')).toHaveText(eur(25_000_000));
    await expect(page.getByRole('button', { name: 'Atualizar valor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Anular venda' })).toBeVisible();
    await expect(page.getByText('Os créditos liquidados mantêm-se liquidados')).toBeVisible();
    await shoot(page, 'disposal-sold-page', heading);
    expect(await axeViolations(page)).toEqual([]);
  });

  test('both leave the lists and wait under "Já não detidos"', async () => {
    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${houseId}`)).toHaveCount(0);
    await expect(page.getByTestId(`nw-item-${mortgageId}`)).toHaveCount(0);

    const exited = page.getByTestId('nw-exited');
    await expect(exited.getByRole('heading', { name: /^Já não detidos/, level: 2 })).toBeVisible();
    // Collapsed until opened.
    await expect(exited.getByTestId(`nw-exited-${houseId}`)).toBeHidden();
    await exited.getByText('Já não detidos').click();
    const house = exited.getByTestId(`nw-exited-${houseId}`);
    await expect(house).toContainText(HOUSE);
    await expect(house).toContainText('Vendido a ');
    await expect(house).toContainText(eur(26_000_000));
    await expect(exited.getByTestId(`nw-exited-${mortgageId}`)).toContainText('Liquidado a ');
    await shoot(page, 'disposal-exited', exited);
    expect(await axeViolations(page)).toEqual([]);

    // The settled mortgage says so, keeps its history and offers the undo.
    await page.goto(`/net-worth/liabilities/${mortgageId}`);
    await expect(settledHeading(/^Liquidado a /)).toBeVisible();
    await expect(page.getByText('Último saldo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Atualizar saldo' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Plano de pagamentos' })).toHaveCount(0);
    await expect(
      page.getByText('O saldo de 0 registado na liquidação mantém-se no histórico'),
    ).toBeVisible();
    await shoot(page, 'disposal-settled-liability');
  });

  test('undoing the sale puts the asset back; the mortgage is undone on its own page', async () => {
    await page.goto(`/net-worth/assets/${houseId}`);
    await page.getByRole('button', { name: 'Anular venda' }).click();
    await expect(
      page.getByText('Venda anulada. O ativo volta a contar no património.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vender' })).toBeVisible();
    // Focus lands on the page title.
    await expect(page.getByRole('heading', { name: HOUSE, level: 1 })).toBeFocused();

    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${houseId}`)).toBeVisible();
    // The mortgage is still settled: not nested, not in the list.
    await expect(page.getByTestId(`nw-credit-${mortgageId}`)).toHaveCount(0);

    await page.goto(`/net-worth/liabilities/${mortgageId}`);
    await page.getByRole('button', { name: 'Anular liquidação' }).click();
    await expect(
      page.getByText('Liquidação anulada. O passivo volta a contar no património.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Liquidar' })).toBeVisible();
    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-credit-${mortgageId}`)).toBeVisible();
  });

  test('writing off with the credit left open: the mortgage offers to settle', async () => {
    await page.goto(`/net-worth/assets/${houseId}`);
    await page.getByRole('button', { name: 'Abater', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Abater ativo' });
    await expect(sheet.getByLabel('Data do abate')).toBeVisible();
    const box = sheet.getByTestId(`settle-${mortgageId}`);
    await box.getByRole('checkbox').uncheck();
    await expect(box).toContainText('Fica em Passivos, associado a um ativo abatido.');
    await expect(sheet.getByText(/^Abate a /)).not.toContainText('liquida');
    await sheet.getByRole('button', { name: 'Abater', exact: true }).click();
    await expect(page.getByText('Abate registado')).toBeVisible();
    await expect(settledHeading(/^Abatido a /)).toBeFocused();
    await expect(page.getByText('Há 1 crédito associado por liquidar.')).toBeVisible();

    await page.goto(`/net-worth/liabilities/${mortgageId}`);
    const alert = page.getByRole('status').filter({ hasText: 'foi abatido a' });
    await expect(alert).toContainText(`${HOUSE} foi abatido a `);
    await expect(page.getByText('(abatido)')).toBeVisible();
    await alert.getByRole('button', { name: 'Liquidar' }).click();
    const sheet2 = page.getByRole('dialog', { name: `Liquidar ${MORTGAGE}` });
    await expect(sheet2.getByLabel('Data de liquidação')).toBeFocused();
    // The undone settlement left its zero balance on today: no second one is announced.
    await expect(sheet2.getByText(/^Fica registado um saldo de/)).toHaveCount(0);
    await sheet2.getByRole('button', { name: 'Liquidar' }).click();
    await expect(page.getByText('Passivo liquidado')).toBeVisible();
    await expect(settledHeading(/^Liquidado a /)).toBeFocused();
  });

  test('deleting asks first, and unlinks what was linked', async () => {
    await page.goto(`/net-worth/assets/${houseId}`);
    await page.getByRole('button', { name: 'Anular abate' }).click();
    await expect(page.getByText('Abate anulado.')).toBeVisible();
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(`Apagar ${HOUSE}?`)).toBeVisible();
    await expect(dialog).toContainText('use antes Vender ou Abater');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toHaveCount(0);
    // Opened from the menu, the dialog hands focus back to the menu's button.
    await expect(page.getByRole('button', { name: 'Mais ações' })).toBeFocused();

    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Ativo apagado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth$/);
    await expect(page.getByTestId(`nw-item-${houseId}`)).toHaveCount(0);

    // The credit stays, with no asset.
    await page.goto(`/net-worth/liabilities/${mortgageId}`);
    await page.getByRole('button', { name: 'Anular liquidação' }).click();
    await expect(page.getByText('Liquidação anulada.')).toBeVisible();
    // Apagar… lives in the record's "Mais ações" menu.
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Apagar', exact: true })
      .click();
    await expect(page.getByText('Passivo apagado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth$/);
  });

  test('no console errors or policy violations', () => {
    expect(problems).toEqual([]);
  });
});
