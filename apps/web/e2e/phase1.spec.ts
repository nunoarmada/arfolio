import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PASSWORD, shoot, signInOwner, watch } from './helpers';

const VIEWER = { name: 'Vic Example', email: 'vic@example.com' };
const REVOLUT = fileURLToPath(
  new URL('../../../packages/services/test/fixtures/import/revolut.csv', import.meta.url),
);
const STATEMENT_XLSX = fileURLToPath(
  new URL('../../../packages/services/test/fixtures/import/statement.xlsx', import.meta.url),
);

const RESTAURANTS = /Restaurantes e cafés|Restaurants and cafes/;
const SALARY = /^Salário$|^Salary$/;

async function addManual(
  page: Page,
  opts: { account: string; direction: 'Saída' | 'Entrada'; amount: string; description: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Movimento manual' }).click();
  const sheet = page.getByRole('dialog', { name: 'Movimento manual' });
  await sheet.getByLabel('Conta', { exact: true }).selectOption({ label: opts.account });
  await sheet.getByLabel(opts.direction).check();
  await sheet.getByLabel('Valor', { exact: true }).fill(opts.amount);
  await sheet.getByLabel('Descrição', { exact: true }).fill(opts.description);
  await sheet.getByRole('button', { name: 'Guardar movimento' }).click();
  // The sheet closes only once the save succeeded, so this waits for this save and not for the
  // toast of an earlier one (toasts stack for six seconds, and two saves in a row show two).
  await expect(sheet).toBeHidden();
  await expect(page.getByText('Movimento adicionado').last()).toBeVisible();
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

test.describe.configure({ mode: 'serial' });

test.describe('phase 1: accounts, import, review', () => {
  const problems: string[] = [];
  let page: Page;
  let browser: Browser;
  let accountId = '';
  let accountUrl = '';

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const ctx = await b.newContext({ locale: 'pt-PT' });
    page = await ctx.newPage();
    watch(page, problems);
    await signInOwner(page);
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('the household currency goes back to EUR so figures read naturally', async () => {
    // The foundation spec left it on USD to prove the setting works.
    await page.goto('/settings/household');
    await page.getByLabel('Moeda').selectOption('EUR');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    await page.goto('/');
  });

  test('the shell shows the Phase 1 navigation and an empty home', async () => {
    await expect(page.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();
    const nav = page.getByRole('complementary');
    for (const name of ['Início', 'Movimentos', 'Contas', 'Definições']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Ainda não há contas.' })).toBeVisible();
    await shoot(page, '20-home-empty');
  });

  test('empty states for accounts, movements and the review inbox', async () => {
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: 'Ainda não há contas.' })).toBeVisible();
    await shoot(page, '21-accounts-empty');
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { name: /Sem movimentos em/ })).toBeVisible();
    await shoot(page, '22-transactions-empty');
    await page.goto('/transactions/review');
    await expect(page.getByRole('heading', { name: 'Tudo revisto.' })).toBeVisible();
    await shoot(page, '23-review-empty');
  });

  test('adds the first account', async () => {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'Adicionar conta' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar conta' });
    // Validation is inline and says what to fix.
    await sheet.getByRole('button', { name: 'Guardar conta' }).click();
    await expect(sheet.getByText('Indique o nome da conta.')).toBeVisible();
    await sheet.getByLabel('Nome', { exact: true }).fill('Conta Corrente');
    await sheet.getByLabel('Instituição').fill('Banco Exemplo');
    await sheet.getByLabel('Moeda').selectOption('EUR');
    await shoot(page, '24-account-form');
    await sheet.getByRole('button', { name: 'Guardar conta' }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/);
    accountUrl = page.url();
    accountId = accountUrl.split('/').pop()!;
    await expect(page.getByRole('heading', { name: 'Conta Corrente', level: 1 })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Sem movimentos neste período.' }),
    ).toBeVisible();
    await shoot(page, '25-account-empty');
  });

  test('imports the Revolut fixture through the wizard', async () => {
    await page.getByRole('link', { name: 'Importar extrato' }).first().click();
    await expect(page).toHaveURL(/\/import\?account=/);
    await expect(page.getByLabel('Conta', { exact: true })).toHaveValue(accountId);
    await shoot(page, '26-import-upload');

    await page.locator('#import-file').setInputFiles(REVOLUT);
    await expect(page.getByTestId('chosen-file')).toHaveText('revolut.csv');
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(page.getByTestId('detected')).toContainText('Revolut');
    await expect(page.getByRole('cell', { name: 'Bakery Example' })).toBeVisible();
    await shoot(page, '27-import-columns');

    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByTestId('stat-new')).toHaveText('3');
    await expect(page.getByTestId('stat-duplicate')).toHaveText('0');
    await expect(page.getByTestId('stat-skipped')).toHaveText('2');
    await expect(page.getByTestId('stat-error')).toHaveText('1');
    await shoot(page, '28-import-preview');

    await page.getByRole('button', { name: 'Continuar' }).click();
    await shoot(page, '29-import-confirm');
    await page.getByRole('button', { name: 'Importar 3 movimentos' }).click();
    await expect(page.getByRole('heading', { name: '3 movimentos importados.' })).toBeVisible();
    await expect(page.getByTestId('result-summary')).toContainText('Por rever: 3');
    await shoot(page, '30-import-result');
  });

  test('the review inbox categorises two movements and advances', async () => {
    await page.getByRole('link', { name: 'Rever agora' }).click();
    await expect(page).toHaveURL(/\/transactions\/review$/);
    await expect(page.getByRole('heading', { name: 'Por rever', level: 1 })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(3);
    await expect(
      page
        .getByRole('complementary')
        .getByRole('link', { name: /Movimentos.*3 movimentos por rever/ }),
    ).toBeVisible();
    await shoot(page, '31-review');

    await page
      .getByRole('article', { name: 'Bakery Example' })
      .getByRole('button', { name: 'Categorizar' })
      .click();
    const picker = page.getByRole('dialog', { name: 'Escolher categoria' });
    await expect(picker).toBeVisible();
    await shoot(page, '32-category-picker');
    await picker.getByRole('button', { name: RESTAURANTS }).click();
    await expect(page.getByText(/^Categorizado como/)).toBeVisible();
    // Review mode: the picker stays open on the next movement.
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: SALARY }).click();
    await expect(picker.getByText(/Coffee Roasters Example/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(
      page
        .getByRole('complementary')
        .getByRole('link', { name: /Movimentos.*1 movimento por rever/ }),
    ).toBeVisible();

    // Undo brings a categorised movement back to the inbox.
    const coffee = page.getByRole('article', { name: 'Coffee Roasters Example' });
    await coffee.getByRole('button', { name: 'Categorizar' }).click();
    await page
      .getByRole('dialog', { name: 'Escolher categoria' })
      .getByRole('button', { name: RESTAURANTS })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Tudo revisto.' })).toBeVisible();
    await shoot(page, '33-review-done');
    await page.getByRole('button', { name: 'Anular' }).last().click();
    await expect(page.getByRole('article', { name: 'Coffee Roasters Example' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(1);
  });

  test('the list groups by day and the detail sheet shows the category and its origin', async () => {
    await page.goto('/transactions?period=all');
    await expect(page.getByRole('heading', { name: 'Movimentos', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /por rever/ }).first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: /, 1(\/03| mar)/i })).toBeVisible();
    await shoot(page, '34-transactions');

    await page.getByRole('button', { name: /Bakery Example/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Detalhe do movimento' });
    await expect(sheet.getByText('Escolhida por si')).toBeVisible();
    await expect(sheet.getByRole('button', { name: RESTAURANTS })).toBeVisible();
    await expect(sheet.getByText('Despesa').first()).toBeVisible();
    await shoot(page, '35-transaction-detail');
    await sheet.getByLabel('Notas').fill('Pão para a semana');
    await sheet.getByLabel('Notas').blur();
    await expect(sheet.getByText('Guardado')).toBeVisible();
    await page.keyboard.press('Escape');

    // Search narrows the list and highlights the match.
    await page.getByLabel('Pesquisar movimentos').fill('bakery');
    await expect(page).toHaveURL(/q=bakery/);
    await expect(page.getByRole('button', { name: /Top-up/ })).toHaveCount(0);
    await expect(page.locator('mark')).toHaveText(/bakery/i);
    await page.getByLabel('Pesquisar movimentos').fill('zzz');
    await expect(
      page.getByRole('heading', { name: 'Nenhum movimento corresponde a "zzz".' }),
    ).toBeVisible();
    await shoot(page, '36-transactions-search-empty');
    await page.getByRole('button', { name: 'Limpar pesquisa' }).click();
    await expect(page.getByRole('button', { name: /Top-up/ })).toBeVisible();

    await page.getByRole('button', { name: /^Categoria/ }).click();
    await shoot(page, '37-filter-sheet');
    await page.keyboard.press('Escape');
  });

  test('re-importing the same file shows nothing new', async () => {
    await page.goto(`/import?account=${accountId}`);
    await page.locator('#import-file').setInputFiles(REVOLUT);
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByTestId('stat-new')).toHaveText('0');
    await expect(page.getByTestId('stat-duplicate')).toHaveText('3');
    await expect(page.getByText('Todos os movimentos deste ficheiro já existem.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
    await shoot(page, '38-import-all-duplicates');
  });

  test('a valid XLSX statement is read by the server and previewed', async () => {
    await page.goto(`/import?account=${accountId}`);
    await page.locator('#import-file').setInputFiles(STATEMENT_XLSX);
    await expect(page.getByTestId('chosen-file')).toHaveText('statement.xlsx');
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(page.getByRole('cell', { name: 'Grocer Example' })).toBeVisible();
    await page.getByRole('button', { name: 'Continuar' }).click();
    // Preview only: nothing is committed, so the later steps keep their counts.
    await expect(page.getByTestId('stat-new')).toHaveText('3');
    await expect(page.getByTestId('stat-skipped')).toHaveText('2');
    await expect(page.getByTestId('stat-error')).toHaveText('0');
  });

  test('an unknown layout is mapped by hand with a live preview', async () => {
    await page.goto(`/import?account=${accountId}`);
    await page.locator('#import-file').setInputFiles({
      name: 'other-bank.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'When,What,HowMuch\n2026-04-01,Corner Shop,-12.50\n2026-04-02,Salary April,1500.00\n',
      ),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(page.getByText('O formato não foi reconhecido.')).toBeVisible();
    await expect(page.getByText('Escolha a data, a descrição e o valor')).toBeVisible();
    await page.getByLabel('Data', { exact: true }).selectOption('When');
    await page.getByLabel('Descrição', { exact: true }).selectOption('What');
    await page.getByLabel('Valor', { exact: true }).selectOption('HowMuch');
    await expect(page.getByRole('cell', { name: 'Corner Shop' })).toBeVisible();
    await shoot(page, '39-import-columns-manual');
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByTestId('stat-new')).toHaveText('2');
  });

  test('unreadable and oversized files are explained before anything is imported', async () => {
    await page.goto(`/import?account=${accountId}`);
    await page.locator('#import-file').setInputFiles({
      name: 'big.csv',
      mimeType: 'text/csv',
      buffer: Buffer.alloc(11 * 1024 * 1024, 'a'),
    });
    await expect(page.getByText('O ficheiro é demasiado grande. O limite é 10 MB.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ler ficheiro' })).toBeDisabled();
    await shoot(page, '50-import-too-large');

    await page.locator('#import-file').setInputFiles({
      name: 'broken.xlsx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('this is not a workbook'),
    });
    await page.getByRole('button', { name: 'Ler ficheiro' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Não foi possível ler o ficheiro' }),
    ).toBeVisible();
    await shoot(page, '51-import-error');
  });

  test('a viewer reads everything and sees no way to change anything', async () => {
    await page.goto('/settings/members');
    await page.getByLabel('Email').fill(VIEWER.email);
    await page.getByLabel('Função').selectOption('viewer');
    await page.getByRole('button', { name: 'Criar convite' }).click();
    const link = await page.getByLabel('Link do convite').inputValue();

    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto(link);
    await guest.getByLabel('Nome').fill(VIEWER.name);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Aceitar e criar conta' }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto('/transactions?period=all');
    await expect(guest.getByRole('button', { name: /Bakery Example/ })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Adicionar', exact: true })).toHaveCount(0);
    await guest.getByRole('button', { name: /Bakery Example/ }).click();
    const sheet = guest.getByRole('dialog', { name: 'Detalhe do movimento' });
    await expect(sheet.getByText('Escolhida por si')).toBeVisible();
    await expect(sheet.getByRole('button', { name: RESTAURANTS })).toHaveCount(0);
    await expect(sheet.getByLabel('Notas')).toHaveAttribute('readonly', '');
    await shoot(guest, '40-detail-as-viewer');
    await guest.keyboard.press('Escape');

    await guest.goto('/accounts');
    await expect(guest.getByRole('link', { name: /Conta Corrente/ })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Adicionar conta' })).toHaveCount(0);
    await guest.goto(accountUrl);
    await expect(guest.getByRole('link', { name: 'Importar extrato' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Editar' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Desfazer importação' })).toHaveCount(0);
    await shoot(guest, '41-account-as-viewer');

    await guest.goto('/transactions/review');
    await expect(guest.getByRole('article')).toHaveCount(1);
    await expect(guest.getByRole('button', { name: 'Categorizar' })).toHaveCount(0);
    await guest.goto('/settings/rules');
    await expect(guest.getByRole('button', { name: 'Nova regra' })).toHaveCount(0);
    await guest.goto('/settings/categories');
    await expect(guest.getByRole('button', { name: 'Nova categoria' })).toHaveCount(0);

    // Not only hidden: a direct call to the server actions is refused by the services (403).
    const zero = '00000000-0000-4000-8000-000000000000';
    const categorise = await callAction(guest.request, 'transactions.ts', 'categoriseAction', [
      { id: zero, categoryId: zero },
    ]);
    expect(categorise).toContain('"code":"forbidden"');
    expect(
      await callAction(guest.request, 'accounts.ts', 'createAccountAction', [
        { name: 'Sneaky', type: 'checking' },
      ]),
    ).toContain('"code":"forbidden"');
    expect(await callAction(guest.request, 'rules.ts', 'deleteRuleAction', [zero])).toContain(
      '"code":"forbidden"',
    );

    const res = await guest.goto('/import');
    expect(res?.status()).toBe(404);
    await ctx.close();
  });

  test('undoing the import warns about edited rows and empties the list', async () => {
    await page.goto(accountUrl);
    await expect(page.getByRole('heading', { name: 'Importações' })).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer importação' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(/^Esta ação elimina 3 movimentos/)).toBeVisible();
    await expect(dialog.getByText(/2 deles foram editados por si/)).toBeVisible();
    await shoot(page, '42-undo-import-dialog');
    await dialog.getByRole('button', { name: 'Desfazer importação' }).click();
    await expect(page.getByText('3 movimentos eliminados')).toBeVisible();

    await page.goto('/transactions?period=all');
    await expect(
      page.getByRole('heading', { name: 'Sem movimentos neste período.' }),
    ).toBeVisible();
    await page.goto('/transactions/review');
    await expect(page.getByRole('heading', { name: 'Tudo revisto.' })).toBeVisible();
    await expect(
      page.getByRole('complementary').getByRole('link', { name: /por rever/ }),
    ).toHaveCount(0);
  });

  test('manual movements, transfers and deleting a manual movement', async () => {
    await page.goto('/accounts?new=1');
    const sheet = page.getByRole('dialog', { name: 'Adicionar conta' });
    await sheet.getByLabel('Nome', { exact: true }).fill('Poupança');
    await sheet.locator('label', { hasText: 'Poupança' }).click();
    await sheet.getByLabel('Moeda').selectOption('EUR');
    await sheet.getByRole('button', { name: 'Guardar conta' }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/);

    await page.goto('/transactions');
    await addManual(page, {
      account: 'Conta Corrente',
      direction: 'Saída',
      amount: '50,00',
      description: 'Para a poupança',
    });
    await addManual(page, {
      account: 'Poupança',
      direction: 'Entrada',
      amount: '50,00',
      description: 'Da conta corrente',
    });
    await expect(page.getByRole('button', { name: /Para a poupança/ })).toBeVisible();

    await page.getByRole('button', { name: /Para a poupança/ }).click();
    const detail = page.getByRole('dialog', { name: 'Detalhe do movimento' });
    await expect(detail.getByRole('heading', { name: 'Marcar como transferência' })).toBeVisible();
    await shoot(page, '43-detail-transfer-candidates');
    await detail.getByRole('button', { name: 'Marcar' }).click();
    await expect(page.getByText('Marcado como transferência')).toBeVisible();
    await expect(
      detail.getByRole('heading', { name: 'Transferência para Poupança' }),
    ).toBeVisible();
    await shoot(page, '44-detail-transfer-linked');
    await detail.getByRole('button', { name: 'Não é uma transferência' }).click();
    // A user unlink only stops automatic pairing: by hand the legs can be linked again.
    await expect(page.getByText('Já não é uma transferência')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Não é uma transferência' })).toHaveCount(0);
    await expect(detail.getByRole('heading', { name: 'Marcar como transferência' })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Marcar', exact: true })).toBeVisible();

    await detail.getByRole('button', { name: 'Eliminar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.getByText('Movimento eliminado')).toBeVisible();
    await expect(page.getByRole('button', { name: /Para a poupança/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Da conta corrente/ })).toBeVisible();
  });

  test('categories and rules settings: add a category, then a rule that uses it', async () => {
    await page.goto('/settings/categories');
    await expect(page.getByRole('heading', { name: 'Categorias', level: 1 })).toBeVisible();
    await shoot(page, '45-settings-categories');
    await page.getByRole('button', { name: 'Nova categoria' }).click();
    const sheet = page.getByRole('dialog', { name: 'Nova categoria' });
    await sheet.getByLabel('Nome', { exact: true }).fill('Animais');
    await sheet.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Criado', { exact: true })).toBeVisible();
    await expect(page.getByText('Animais', { exact: true })).toBeVisible();

    // Moving a group up persists (the transfer group is not part of the ordering).
    await page.getByRole('button', { name: 'Subir o grupo Habitação' }).click();
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Habitação');
    await page.reload();
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Habitação');
    await expect(page.getByRole('heading', { level: 2 }).nth(1)).toHaveText('Receitas');

    await page.goto('/settings/rules');
    await expect(page.getByRole('heading', { name: 'Ainda não há regras.' })).toBeVisible();
    await shoot(page, '46-settings-rules-empty');
    await page.getByRole('button', { name: 'Nova regra' }).first().click();
    const rule = page.getByRole('dialog', { name: 'Nova regra' });
    await rule.getByRole('button', { name: 'Guardar regra' }).click();
    await expect(rule.getByText('Indique o nome da regra.')).toBeVisible();
    await rule.getByLabel('Nome da regra').fill('Ração');
    await rule.getByLabel('A descrição contém').fill('petshop');
    await rule.getByRole('button', { name: 'Escolher categoria' }).click();
    await page
      .getByRole('dialog', { name: 'Escolher categoria' })
      .getByRole('button', { name: 'Animais' })
      .click();
    await rule.getByRole('button', { name: 'Guardar regra' }).click();
    await expect(page.getByText('Se a descrição contém "petshop" → Animais')).toBeVisible();
    await shoot(page, '47-settings-rules');

    await page.goto('/settings/import');
    await expect(
      page.getByRole('heading', { name: 'Formatos de importação', level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Ainda não há formatos guardados.' }),
    ).toBeVisible();
  });

  test('applying a category to a merchant categorises its other open rows, and undo restores both', async () => {
    await page.goto('/transactions');
    for (const description of ['Merch Test 01/06', 'Merch Test 02/06']) {
      await addManual(page, {
        account: 'Conta Corrente',
        direction: 'Saída',
        amount: '12,00',
        description,
      });
    }
    await page.getByRole('button', { name: /Merch Test 02\/06/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Detalhe do movimento' });
    await sheet.getByRole('button', { name: /Sem categoria/ }).click();
    const picker = page.getByRole('dialog', { name: 'Escolher categoria' });
    await expect(
      picker.getByLabel(/Aplicar também aos outros movimentos de MERCH TEST/),
    ).toBeChecked();
    await picker.getByRole('button', { name: RESTAURANTS }).first().click();
    await expect(page.getByText(/e mais 1 movimento do mesmo comerciante/)).toBeVisible();
    await sheet.getByRole('button', { name: 'Fechar' }).click();
    await expect(sheet).toBeHidden();
    for (const day of ['01/06', '02/06']) {
      await expect(
        page.getByRole('button', { name: new RegExp(`Merch Test ${day}.*Restaurantes e cafés`) }),
      ).toBeVisible();
    }
    await page.getByRole('button', { name: 'Anular' }).last().click();
    for (const day of ['01/06', '02/06']) {
      await expect(
        page.getByRole('button', { name: new RegExp(`Merch Test ${day}.*Sem categoria`) }),
      ).toBeVisible();
    }
  });

  test('"Não é" on a transfer hint is saved: the hint does not come back after a reload', async () => {
    await page.goto('/transactions');
    await addManual(page, {
      account: 'Conta Corrente',
      direction: 'Saída',
      amount: '33,00',
      description: 'Hint out',
    });
    await addManual(page, {
      account: 'Poupança',
      direction: 'Entrada',
      amount: '33,00',
      description: 'Hint in',
    });
    await page.goto('/transactions/review');
    const hinted = page.getByRole('article', { name: 'Hint out' });
    await expect(hinted.getByText('Possível transferência')).toBeVisible();
    await hinted.getByRole('button', { name: 'Não é' }).click();
    await expect(hinted.getByText('Possível transferência')).toHaveCount(0);
    await page.reload();
    for (const name of ['Hint out', 'Hint in']) {
      const row = page.getByRole('article', { name });
      await expect(row).toBeVisible();
      await expect(row.getByText('Possível transferência')).toHaveCount(0);
    }
  });

  test('the manual movement form keeps its choices when the page behind it re-renders', async () => {
    await page.goto('/transactions');
    await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Movimento manual' }).click();
    const sheet = page.getByRole('dialog', { name: 'Movimento manual' });
    const account = sheet.getByLabel('Conta', { exact: true });
    await account.selectOption({ label: 'Poupança' });
    await sheet.getByLabel('Entrada').check();
    const savings = await account.inputValue();
    // The sheet turns aria-hidden once the detail dialog opens over it, so keep a direct handle.
    const accountSelect = (await account.elementHandle())!;

    // Anything that re-renders the list behind the sheet (the reload after a previous save, a
    // router refresh) used to reset the form to its defaults. A click on a row, sent straight to
    // the element because the sheet makes the page inert, is such a re-render: it selects the row.
    await page.locator('button', { hasText: 'Hint out' }).first().dispatchEvent('click');
    await expect(page.getByRole('dialog', { name: 'Detalhe do movimento' })).toBeVisible();

    await expect(page.locator('input[name="direction"]').nth(1)).toBeChecked();
    await expect.poll(() => accountSelect.inputValue()).toBe(savings);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  });

  test('home and accounts show the figures once there is data', async () => {
    await page.goto('/');
    // No budget yet: the month block still says how much was spent, and where to make a budget.
    const month = page.getByRole('region', { name: 'Este mês' });
    await expect(month).toBeVisible();
    await expect(month.getByText('Saídas este mês')).toBeVisible();
    await expect(month.getByRole('link', { name: 'Criar orçamento' })).toBeVisible();
    // The available balance moved into "Contas e ligações" (the account list is Contas' job).
    const overview = page.getByRole('region', { name: 'Contas e ligações' });
    await expect(overview.getByText('Saldo disponível')).toBeVisible();
    await expect(overview.getByRole('link', { name: 'Ver contas' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Património' })).toBeVisible();
    await shoot(page, '48-home');
    // The latest movements are no longer on Início: they are the top of Movimentos.
    await expect(page.getByRole('heading', { name: 'Últimos movimentos' })).toHaveCount(0);
    await page.goto('/transactions');
    await expect(page.getByText('Hint in').first()).toBeVisible();
    await expect(page.getByText('Hint out').first()).toBeVisible();
    await page.goto('/accounts');
    await expect(page.getByRole('heading', { name: 'Contas à ordem' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Poupança', level: 2 })).toBeVisible();
    await shoot(page, '49-accounts');
  });

  test('loading skeletons match the final layouts, and a missing movement is a 404', async () => {
    await page.goto('/');
    // Let the links finish prefetching their loading shells before navigation is slowed down.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_500);
    const slow = /_rsc=/;
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      // A request the page already gave up on (it navigated on) cannot be continued any more.
      await route.continue().catch((error: Error) => {
        if (!/already handled/i.test(error.message)) throw error;
      });
    });
    const nav = page.getByRole('complementary');
    for (const [link, shot] of [
      [/^Movimentos/, '52-transactions-loading'],
      [/^Contas/, '53-accounts-loading'],
    ] as const) {
      await nav.getByRole('link', { name: link }).click();
      // The skeleton only appears after 200ms, so quick loads never flash.
      await page.waitForTimeout(500);
      await expect(page.getByRole('status').filter({ hasText: 'A carregar…' })).toBeAttached();
      await shoot(page, shot);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    }
    await page.unroute(slow);

    // The loading boundary has already streamed (status 200) when the page decides it is a 404.
    await page.goto('/transactions/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    await shoot(page, '54-not-found');
  });

  test('the owner deletes an account after typing its name', async () => {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'Adicionar conta' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar conta' });
    await sheet.getByLabel('Nome', { exact: true }).fill('Conta a apagar');
    await sheet.getByRole('button', { name: 'Guardar conta' }).click();
    await expect(page.getByRole('heading', { name: 'Conta a apagar', level: 1 })).toBeVisible();

    // Destructive entry points live in the "more actions" menu, not in plain view.
    await expect(page.getByRole('button', { name: 'Apagar conta' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar conta' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Apagar Conta a apagar?' });
    // Closing without deleting hands focus back to the "⋯" button (the dialog has no Trigger).
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: /Mais ações/ })).toBeFocused();
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Arquivar' }).click();
    const archive = page.getByRole('alertdialog', { name: /^Arquivar Conta a apagar/ });
    await archive.getByRole('button', { name: 'Cancelar' }).click();
    await expect(archive).toBeHidden();
    await expect(page.getByRole('button', { name: /Mais ações/ })).toBeFocused();
    await page.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('menuitem', { name: 'Apagar conta' }).click();
    const confirm = dialog.getByRole('button', { name: 'Apagar conta' });
    const name = dialog.getByLabel('Escreva Conta a apagar para confirmar');
    await expect(confirm).toBeDisabled();
    await name.fill('conta a apagar');
    await expect(confirm).toBeDisabled();
    await name.fill(' Conta a apagar ');
    await expect(confirm).toBeEnabled();
    await shoot(page, '55-account-delete');
    await confirm.click();

    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByText('Conta apagada')).toBeVisible();
    await expect(page.getByRole('link', { name: /Conta a apagar/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Conta Corrente/ }).first()).toBeVisible();
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
