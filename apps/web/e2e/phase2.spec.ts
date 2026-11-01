import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import {
  FAKE_BANK_NAME,
  FAKE_BANK_ORIGIN,
  FAKE_BETA_BANK_NAME,
  FAKE_T212_OTHER,
  FAKE_T212_RENEWED,
} from './fakes';
import { PASSWORD, nativeSubmit, newOwnerContext, shoot, signInOwner, watch } from './helpers';

const VIEWER = { email: 'vic@example.com' };
const CALLBACK = '/api/connections/callback';

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
const bankConnectionId = async (): Promise<string> =>
  (await sql<{ id: string }>("select id from connection where provider = 'enablebanking'"))[0]!.id;

test.describe.configure({ mode: 'serial' });

test.describe('phase 2: connections, consent, notifications, AI suggestions', () => {
  const problems: string[] = [];
  let browser: Browser;
  let page: Page;
  let codeCounter = 0;
  const callbackUrls: string[] = [];

  /** The fake bank: instead of a real login page, bounce straight back with a fresh code. */
  async function simulateBank(p: Page): Promise<void> {
    await p.route(`${FAKE_BANK_ORIGIN}/**`, (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get('redirect_url')!);
      back.searchParams.set('state', u.searchParams.get('state')!);
      const unstable = u.searchParams.get('aspsp') === FAKE_BETA_BANK_NAME ? 'unstable-' : '';
      back.searchParams.set('code', `fakecode-${unstable}${(codeCounter += 1)}`);
      callbackUrls.push(back.toString());
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    });
  }

  const bank = (): Locator => page.getByRole('article', { name: FAKE_BANK_NAME });
  const sidebarBell = (label: string): Locator =>
    page.locator(`aside button[aria-label="${label}"]`);

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    const ctx = await newOwnerContext(b);
    page = await ctx.newPage();
    watch(page, problems);
    // The bank logo host from the fake list must never be requested (the CSP only allows self).
    page.on('request', (r) => {
      if (r.url().includes('logos.example.test')) problems.push(`logo requested: ${r.url()}`);
    });
    await signInOwner(page);
    await simulateBank(page);
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  test('connections start empty, the bell is in the sidebar and its panel is empty', async () => {
    await page.goto('/connections');
    await expect(page.getByRole('heading', { name: 'Ligações', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ainda não há ligações.' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Contas e ligações' });
    await expect(nav.getByRole('link', { name: 'Ligações' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // "Contas" stays active in the sidebar for the whole section.
    await expect(
      page.getByRole('complementary').getByRole('link', { name: 'Contas', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await shoot(page, '60-connections-empty');

    // The bell sits directly above Definições.
    const aside = page.getByRole('complementary');
    const bell = aside.getByRole('button', { name: 'Notificações', exact: true });
    const settings = aside.getByRole('link', { name: 'Definições' });
    const bellBox = (await bell.boundingBox())!;
    const settingsBox = (await settings.boundingBox())!;
    expect(bellBox.y).toBeLessThan(settingsBox.y);

    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notificações' });
    await expect(panel.getByText('Sem notificações.')).toBeVisible();
    await shoot(page, '61-notifications-empty');
    await page.keyboard.press('Escape');
    await expect(bell).toBeFocused();
  });

  test('bank picker: country defaults to Portugal, search ignores accents, monograms only', async () => {
    await page.getByRole('main').getByRole('link', { name: 'Adicionar ligação' }).first().click();
    await expect(page).toHaveURL(/\/connections\/new$/);
    await shoot(page, '62-connections-new');
    await page.getByRole('link', { name: /^Banco/ }).click();
    await expect(page).toHaveURL(/\/connections\/new\/bank/);
    await expect(page.getByLabel('País do banco')).toHaveValue('PT');
    await expect(page.getByText('Passo 1 de 3 · Escolher banco')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^2 bancos$/ })).toBeVisible();
    await page.getByLabel('Pesquisar banco').fill('credito');
    await expect(page.getByRole('button', { name: /Crédito Fictício/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Banco Exemplo/ })).toHaveCount(0);
    await expect(page.getByText('Beta')).toBeVisible();
    await page.getByLabel('Pesquisar banco').fill('zzz');
    await expect(page.getByText('Nenhum banco corresponde a "zzz".')).toBeVisible();
    await page.getByRole('button', { name: 'Limpar pesquisa' }).click();
    await expect(page.locator('img')).toHaveCount(0);
    await shoot(page, '63-bank-picker');

    // A country without banks says so.
    await page.getByLabel('País do banco').selectOption('ES');
    await expect(page.getByText('Não há bancos disponíveis para Espanha.')).toBeVisible();
    await shoot(page, '63b-bank-picker-empty');
    await page.getByLabel('País do banco').selectOption('PT');
    await expect(page.getByRole('button', { name: /Banco Exemplo/ })).toBeVisible();
  });

  test('explains the consent, goes to the bank, comes back through the callback and links accounts', async () => {
    await page.getByRole('button', { name: /Banco Exemplo/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Autorizar o acesso ao Banco Exemplo', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Só leitura.')).toBeVisible();
    await expect(page.getByText(/Válido durante 90 dias/)).toBeVisible();
    await expect(page.getByText(/Pode revogar o acesso a qualquer momento/)).toBeVisible();
    await expect(page.getByText(/regras europeias de acesso a contas \(PSD2\)/)).toBeVisible();
    await shoot(page, '64-authorise');

    await page.getByRole('button', { name: 'Continuar para o Banco Exemplo' }).click();
    await expect(page).toHaveURL(/\/connections\/[0-9a-f-]{36}\/link\?from=consent$/);
    await expect(page.getByRole('heading', { name: 'Associar contas', level: 1 })).toBeFocused();
    await expect(page.getByText('Passo 3 de 3 · Associar contas')).toBeVisible();
    // Only the last four characters of the IBAN ever reach the page.
    await expect(page.getByText('···· 0154')).toBeVisible();
    await expect(page.getByText('PT50')).toHaveCount(0);
    await expect(page.getByLabel('Criar conta nova')).toBeChecked();
    await expect(page.getByLabel('Nome da conta')).toHaveValue('Conta Ordem');
    await shoot(page, '65-link-accounts');

    // Client validation first: summary, inline error, nothing is sent.
    await page.getByLabel('Nome da conta').fill('');
    await page.getByRole('button', { name: 'Associar 1 conta' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText('Corrija os campos indicados.');
    await expect(page.getByText('Indique um nome para a conta.').last()).toBeVisible();
    await shoot(page, '66-link-accounts-error');
    await page.getByLabel('Nome da conta').fill('Conta Ordem');
    await page.getByRole('button', { name: 'Associar 1 conta' }).click();

    await expect(page).toHaveURL(/\/connections$/);
    await expect(
      page.getByText('1 conta associada. A primeira sincronização começa dentro de momentos.'),
    ).toBeVisible();
    await expect(bank().getByRole('heading', { name: FAKE_BANK_NAME, level: 2 })).toBeVisible();
    await expect(bank().getByText('A aguardar a primeira sincronização')).toBeVisible();
    await expect(bank().getByText('Conta Ordem')).toBeVisible();
    await expect(bank().getByText(/Válido até .* · faltam 8[89] dias/)).toBeVisible();
    // Reloading does not repeat the outcome: the parameters were stripped.
    await page.reload();
    await expect(page.getByText('1 conta associada.')).toHaveCount(0);
    await shoot(page, '67-connections-waiting');
  });

  test('sync now brings the movements, counts the manual refreshes and then waits', async () => {
    await expect(bank().getByText('Restam 2 atualizações manuais hoje')).toBeVisible();
    await bank().getByRole('button', { name: 'Sincronizar agora' }).click();
    await expect(page.getByText('Sincronizado · 3 movimentos novos')).toBeVisible();
    await expect(bank().getByText(/Sincronizado agora mesmo/)).toBeVisible();
    await expect(bank().getByText('Resta 1 atualização manual hoje')).toBeVisible();
    await shoot(page, '68-connections-synced');

    await bank().getByRole('button', { name: 'Sincronizar agora' }).click();
    await expect(page.getByText('Sincronizado · sem movimentos novos')).toBeVisible();
    const sync = bank().getByRole('button', { name: 'Sincronizar agora' });
    await expect(bank().getByText(/Próxima atualização manual (às|amanhã)/)).toBeVisible();
    // Out of refreshes: aria-disabled (still focusable, so the reason can be reached), not disabled.
    await expect(sync).toHaveAttribute('aria-disabled', 'true');
    await expect(sync).not.toHaveAttribute('disabled', '');
    await sync.focus();
    await expect(sync).toBeFocused();
    await sync.click({ force: true });
    await expect(sync).toHaveAttribute('aria-disabled', 'true');

    await page.goto('/transactions?period=all');
    await expect(page.getByRole('button', { name: /Continente Modelo/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Empresa Exemplo Lda/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Padaria Central/ })).toBeVisible();

    await page.goto('/');
    const strip = page.getByRole('link', { name: /^Estado das ligações: Banco Exemplo, / });
    await expect(strip).toBeVisible();
    await shoot(page, '69-home-strip');
  });

  test('a running connection manages its accounts: stop syncing one, keep its movements, link it again', async () => {
    await page.goto('/connections');
    await bank()
      .getByRole('link', { name: `Gerir contas de ${FAKE_BANK_NAME}` })
      .click();
    await expect(page).toHaveURL(/\/connections\/[0-9a-f-]{36}\/link$/);
    await expect(page.getByRole('heading', { name: 'Gerir contas', level: 1 })).toBeFocused();
    // Not part of the connect flow: no step line.
    await expect(page.getByText(/Passo \d de \d/)).toHaveCount(0);
    await expect(page.getByText('Associada a Conta Ordem')).toBeVisible();

    await page.getByRole('button', { name: 'Alterar' }).click();
    await page
      .getByRole('radiogroup', { name: 'O que fazer com Conta Ordem' })
      .getByLabel('Deixar de sincronizar')
      .check();
    await expect(page.getByText(/A conta e os movimentos já importados mantêm-se/)).toBeVisible();
    await shoot(page, '67b-manage-stop');
    await page.getByRole('button', { name: 'Guardar alterações' }).click();

    await expect(page).toHaveURL(/\/connections$/);
    await expect(page.getByText(`${FAKE_BANK_NAME}: nenhuma conta sincronizada.`)).toBeVisible();
    await expect(bank().getByText('Conta Ordem')).toHaveCount(0);
    // The account and its movements stay.
    await page.goto('/transactions?period=all');
    await expect(page.getByRole('button', { name: /Continente Modelo/ })).toBeVisible();

    // Start syncing it again, on the same account.
    await page.goto('/connections');
    await bank()
      .getByRole('link', { name: `Gerir contas de ${FAKE_BANK_NAME}` })
      .click();
    const row = page.getByRole('radiogroup', { name: 'O que fazer com Conta Ordem' });
    await row.getByLabel('Associar a uma conta existente').check();
    await page.locator('#link-0-account').selectOption({ label: 'Conta Ordem' });
    await page.getByRole('button', { name: 'Associar 1 conta' }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await expect(page.getByText(`${FAKE_BANK_NAME}: 1 conta sincronizada.`)).toBeVisible();
    await expect(bank().getByText('Conta Ordem')).toBeVisible();
  });

  test('forged, reused and cancelled authorisations are refused with fixed messages', async () => {
    const forged = `${CALLBACK}?state=${'a'.repeat(43)}&code=fakecode-999`;
    const res = await page.request.get(forged, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(res.headers().location).toMatch(/\/connections\?result=state_invalid$/);

    await page.goto(forged);
    await expect(page.locator('main [role="alert"]')).toContainText(
      'Não foi possível confirmar este pedido de autorização.',
    );
    // Focus lands on the outcome, so a screen reader reads it first.
    await expect(page.locator('main div[tabindex="-1"]:has([role="alert"])')).toBeFocused();
    await expect(page).toHaveURL(/\/connections$/);
    await shoot(page, '70-callback-invalid');

    // Malformed input never reaches the service and says the same thing.
    await page.goto(`${CALLBACK}?state=<script>&code=x`);
    await expect(page.locator('main [role="alert"]')).toContainText('Não foi possível confirmar');

    // Replaying the callback that already created the connection.
    await page.goto(callbackUrls[0]!);
    await expect(page.getByText(/Esta autorização já foi usada/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Tentar de novo' })).toBeVisible();
    await shoot(page, '71-callback-used');

    // The bank says no: any `error` is a cancellation and its text is never shown.
    await page.goto(`${CALLBACK}?error=access_denied&error_description=EVIL_PROVIDER_TEXT`);
    await expect(
      page.getByText('A autorização foi cancelada no banco. Nada foi alterado.'),
    ).toBeVisible();
    await expect(page.getByText('EVIL_PROVIDER_TEXT')).toHaveCount(0);
    await expect(page.getByText('access_denied')).toHaveCount(0);

    // Unknown result codes render nothing.
    await page.goto('/connections?result=%3Cb%3Ehi%3C%2Fb%3E');
    await expect(page.locator('main [role="alert"]')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /^$/ }).first()).toBeAttached();
  });

  test('a signed-out visitor is sent to sign in and the callback is kept as the way back', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const res = await ctx.request.get(`${CALLBACK}?state=abc&code=def`, { maxRedirects: 0 });
    expect(res.status()).toBe(303);
    const location = new URL(res.headers().location!);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('next')).toBe(`${CALLBACK}?state=abc&code=def`);
    await ctx.close();
  });

  test('an account with no permanent identifier is flagged, and one account cannot be linked twice', async () => {
    await page.goto('/connections/new/bank?country=PT');
    await page.getByRole('button', { name: /Crédito Fictício/ }).click();
    await page.getByRole('button', { name: 'Continuar para o Crédito Fictício' }).click();
    await expect(page).toHaveURL(/\/connections\/[0-9a-f-]{36}\/link\?from=consent$/);
    // Only the account without an IBAN carries the warning.
    await expect(
      page.getByText('Este banco não dá a esta conta um identificador permanente.'),
    ).toHaveCount(1);
    await shoot(page, '66b-link-unstable');

    for (const [index, name] of ['Conta Ordem', 'Conta sem IBAN'].entries()) {
      await page
        .getByRole('radiogroup', { name: `O que fazer com ${name}` })
        .getByLabel('Associar a uma conta existente')
        .check();
      await page.locator(`#link-${index}-account`).selectOption({ label: 'Conta Corrente' });
    }
    await page.getByRole('button', { name: 'Associar 2 contas' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText('Corrija os campos indicados.');
    await expect(page.getByText('Esta conta já foi escolhida acima.').last()).toBeVisible();
    await expect(page.locator('#link-1-account')).toHaveAttribute('aria-invalid', 'true');
    await shoot(page, '66c-link-duplicate', page.locator('#link-1-account'));

    // Leave it for later, then remove the half-finished connection: it offers "Associar contas".
    await page.getByRole('link', { name: 'Fazer mais tarde' }).click();
    const card = page.getByRole('article', { name: FAKE_BETA_BANK_NAME });
    await expect(card.getByRole('link', { name: 'Associar contas' })).toBeVisible();
    await card.getByRole('button', { name: `Remover a ligação a ${FAKE_BETA_BANK_NAME}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remover ligação' }).click();
    await expect(page.getByText('Ligação removida')).toBeVisible();
    await expect(card).toHaveCount(0);
  });

  test('an expired consent offers "Renovar acesso", and renewing brings it back', async () => {
    await sql(
      "update connection set consent_expires_at = now() - interval '3 days', status = 'expired' where provider = 'enablebanking'",
    );
    await page.goto('/connections');
    await expect(bank().getByText('Acesso expirado')).toBeVisible();
    await expect(bank().getByText(/Expirou a /)).toBeVisible();
    await expect(
      bank().getByText('O acesso ao banco expirou. Renove o acesso para retomar a sincronização.'),
    ).toBeVisible();
    await expect(bank().getByRole('link', { name: 'Renovar acesso' })).toBeVisible();
    await expect(bank().getByRole('button', { name: 'Sincronizar agora' })).toHaveCount(0);
    await expect(page.getByText('1 ligação precisa de atenção')).toBeVisible();
    await shoot(page, '72-connections-expired');

    await page.goto('/');
    await expect(page.getByText('A ligação ao Banco Exemplo expirou.')).toBeVisible();
    await shoot(page, '73-home-expired');

    await page.goto('/connections');
    await bank().getByRole('link', { name: 'Renovar acesso' }).click();
    await expect(
      page.getByRole('heading', { name: 'Renovar o acesso ao Banco Exemplo', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(/As contas associadas mantêm-se/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Escolher outro banco' })).toHaveCount(0);
    await shoot(page, '74-renew');
    await page.getByRole('button', { name: 'Renovar no Banco Exemplo' }).click();

    await expect(page).toHaveURL(/\/connections$/);
    await expect(page.getByText(/Acesso ao Banco Exemplo renovado até /)).toBeVisible();
    await expect(bank().getByText('Acesso expirado')).toHaveCount(0);
    await expect(bank().getByRole('button', { name: 'Sincronizar agora' })).toBeVisible();
    await shoot(page, '75-connections-renewed');
  });

  test('the Trading 212 key form submitted before hydration keeps the key out of the URL', async () => {
    const key = 'pre-hydration-key-4';
    const secret = 'pre-hydration-secret-5';
    const res = await nativeSubmit(
      browser,
      '/connections/new/trading212',
      async (p) => {
        await p.getByLabel('Chave API').fill(key);
        const secretField = p.getByLabel('Segredo da API');
        await secretField.fill(secret);
        await expect(p.getByRole('button', { name: 'Validar e guardar' })).toBeDisabled();
        await secretField.evaluate((el) => (el as HTMLInputElement).form!.requestSubmit());
      },
      await page.context().storageState(),
    );
    for (const value of [key, secret]) {
      expect(res.url).not.toContain(value);
      expect(res.urls.filter((u) => u.includes(value))).toEqual([]);
      expect(res.body).not.toContain(value);
    }
    expect(res.status).toBeLessThan(500);
  });

  test('a wrong Trading 212 key is explained; the right one connects and syncs', async () => {
    await page.goto('/connections/new');
    await page.getByRole('link', { name: /^Trading 212/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Ligar a Trading 212', level: 1 }),
    ).toBeVisible();
    for (const scope of [
      'account',
      'portfolio',
      'history:transactions',
      'history:dividends',
      'history:orders',
    ]) {
      await expect(page.getByText(scope, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Não ative permissões para colocar ordens.')).toBeVisible();

    await page.getByRole('button', { name: 'Validar e guardar' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText('Corrija os campos indicados.');
    await expect(page.getByText('Cole a chave API.').last()).toBeVisible();

    await page.getByLabel('Chave API').fill('wrong-key');
    await page.getByLabel('Segredo da API').fill('wrong-secret');
    await page.getByRole('button', { name: 'Validar e guardar' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText(
      'A Trading 212 recusou a chave.',
    );
    await expect(page.getByLabel('Chave API')).toHaveValue('wrong-key');
    await shoot(page, '76-t212-error');

    // The secret has a show/hide toggle and is never rendered back after saving.
    await expect(page.getByLabel('Segredo da API')).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Mostrar segredo' }).click();
    await expect(page.getByLabel('Segredo da API')).toHaveAttribute('type', 'text');
    await page.getByLabel('Chave API').fill(process.env.E2E_T212_KEY!);
    await page.getByLabel('Segredo da API').fill(process.env.E2E_T212_SECRET!);
    await page.getByRole('button', { name: 'Validar e guardar' }).click();

    await expect(page).toHaveURL(/\/connections\/[0-9a-f-]{36}\/link\?from=t212$/);
    await expect(page.getByText('Passo 2 de 2 · Associar contas')).toBeVisible();
    await expect(page.getByLabel('Tipo de conta')).toHaveValue('investment');
    await expect(page.getByLabel('Nome da conta')).toHaveValue('Trading 212');
    await page.getByRole('button', { name: 'Associar 1 conta' }).click();

    await expect(page).toHaveURL(/\/connections$/);
    const t212 = page.getByRole('article', { name: 'Trading 212' });
    await expect(t212.getByText('Acesso por chave API · sem prazo')).toBeVisible();
    await expect(t212.getByText('Pode sincronizar de 5 em 5 minutos')).toBeVisible();
    await t212.getByRole('button', { name: 'Sincronizar agora' }).click();
    await expect(page.getByText(/Sincronizado · \d+ movimentos? novos?/)).toBeVisible();
    await expect(t212.getByText(/Próxima atualização manual (às|amanhã)/)).toBeVisible();
    await shoot(page, '77-connections-two');
  });

  test('an expired Trading 212 key is updated in place, and only with keys of the same account', async () => {
    await sql(
      "update connection set status = 'expired', next_sync_at = null, consecutive_failures = 3, last_error_code = 'auth', last_error_message = 'The provider rejected the credentials or consent; reconnect to resume syncing' where provider = 'trading212'",
    );
    const t212 = page.getByRole('article', { name: 'Trading 212' });
    await page.goto('/connections');
    await expect(t212.getByText('a Trading 212 recusou a chave')).toBeVisible();
    await expect(t212.getByRole('button', { name: 'Sincronizar agora' })).toHaveCount(0);
    await shoot(page, '77a-t212-expired');

    await t212.getByRole('link', { name: 'Atualizar chave' }).click();
    await expect(page).toHaveURL(/\/connections\/new\/trading212\?connection=[0-9a-f-]{36}$/);
    await expect(
      page.getByRole('heading', { name: 'Atualizar a chave da Trading 212', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Ligação: Trading 212')).toBeVisible();
    await expect(page.getByLabel('Nome da ligação')).toHaveCount(0);

    // A key the broker refuses.
    await page.getByLabel('Chave API').fill('wrong-key');
    await page.getByLabel('Segredo da API').fill('wrong-secret');
    await page.getByRole('button', { name: 'Validar e atualizar' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText(
      'A Trading 212 recusou a chave.',
    );

    // A valid key of another Trading 212 account is refused and changes nothing.
    await page.getByLabel('Chave API').fill(FAKE_T212_OTHER.key);
    await page.getByLabel('Segredo da API').fill(FAKE_T212_OTHER.secret);
    await page.getByRole('button', { name: 'Validar e atualizar' }).click();
    await expect(page.locator('main [role="alert"]')).toContainText(
      'Estas chaves são de outra conta Trading 212.',
    );
    await shoot(page, '77b-t212-different-account');
    expect(
      (
        await sql<{ status: string }>("select status from connection where provider = 'trading212'")
      )[0]!.status,
    ).toBe('expired');

    // The new key of the same account brings it back.
    await page.getByLabel('Chave API').fill(FAKE_T212_RENEWED.key);
    await page.getByLabel('Segredo da API').fill(FAKE_T212_RENEWED.secret);
    await page.getByRole('button', { name: 'Validar e atualizar' }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await expect(
      page.getByText('Chave da Trading 212 atualizada. A sincronização começa dentro de momentos.'),
    ).toBeVisible();
    await expect(t212.getByRole('link', { name: 'Atualizar chave' })).toHaveCount(0);
    await expect(t212.getByRole('button', { name: 'Sincronizar agora' })).toBeVisible();
    const [row] = await sql<{ status: string; failures: number; code: string | null }>(
      "select status, consecutive_failures as failures, last_error_code as code from connection where provider = 'trading212'",
    );
    expect(row).toEqual({ status: 'active', failures: 0, code: null });
    await shoot(page, '77c-t212-key-updated');
  });

  test('removing a connection keeps its movements and asks first', async () => {
    const t212 = page.getByRole('article', { name: 'Trading 212' });
    await t212.getByRole('button', { name: 'Remover a ligação a Trading 212' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remover a ligação a Trading 212?' });
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expect(dialog).toContainText('mantêm-se');
    await expect(dialog).toContainText('A chave API é apagada desta aplicação');
    await shoot(page, '78-remove-dialog');
    await dialog.getByRole('button', { name: 'Remover ligação' }).click();
    await expect(page.getByText('Ligação removida')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Trading 212' })).toHaveCount(0);
    // Focus moves to the next card heading.
    await expect(page.getByRole('heading', { name: FAKE_BANK_NAME, level: 2 })).toBeFocused();
    // The account it fed is still there, with its movements.
    await page.goto('/accounts');
    await expect(page.getByRole('link', { name: /Trading 212/ })).toBeVisible();
  });

  test('notifications: unread count, panel, mark one and mark all read', async () => {
    const hid = await householdId();
    const conn = await bankConnectionId();
    const in5Days = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await sql(
      `insert into notification (household_id, user_id, kind, payload, dedupe_key) values
        ($1, null, 'consent_expiring', $2::jsonb, 'e2e-expiring'),
        ($1, null, 'sync_failing', $3::jsonb, 'e2e-failing')`,
      [
        hid,
        JSON.stringify({ connectionId: conn, displayName: FAKE_BANK_NAME, expiresAt: in5Days }),
        JSON.stringify({
          connectionId: conn,
          displayName: FAKE_BANK_NAME,
          consecutiveFailures: 3,
          errorCode: 'unavailable',
        }),
      ],
    );

    // Phone: the bell is the last action of the top bar of a top-level page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(
      page.locator('header').getByRole('button', { name: 'Notificações, 2 por ler' }),
    ).toBeVisible();
    await shoot(page, '79-bell-mobile');
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto('/');
    const bell = page
      .getByRole('complementary')
      .getByRole('button', { name: 'Notificações, 2 por ler' });
    await expect(bell).toBeVisible();
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog');
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notificações' });
    await expect(panel.getByText(/O acesso ao Banco Exemplo expira em [45] dias/)).toBeVisible();
    await expect(panel.getByText(/Renove antes de .* para não perder movimentos\./)).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Renovar acesso' })).toBeVisible();
    await expect(panel.getByText('A sincronização do Banco Exemplo está a falhar')).toBeVisible();
    await expect(
      panel.getByText(/3 falhas seguidas: o serviço do banco está indisponível\./),
    ).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Ver ligação' })).toBeVisible();
    // Opening the panel does not mark anything read.
    await expect(sidebarBell('Notificações, 2 por ler')).toBeAttached();
    await shoot(page, '80-notifications');

    await panel
      .getByRole('button', { name: /^Marcar como lida: O acesso ao Banco Exemplo/ })
      .click();
    await expect(sidebarBell('Notificações, 1 por ler')).toBeAttached();
    await panel.getByRole('button', { name: 'Marcar todas como lidas' }).click();
    await expect(sidebarBell('Notificações')).toBeAttached();
    await expect(panel.getByRole('button', { name: /Marcar como lida/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('complementary').getByRole('button', { name: 'Notificações', exact: true }),
    ).toBeFocused();
  });

  test('read state is per person: a viewer still has both unread, and sees nothing to change', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);
    await expect(
      guest.getByRole('complementary').getByRole('button', { name: 'Notificações, 2 por ler' }),
    ).toBeVisible();

    await guest.goto('/connections');
    const card = guest.getByRole('article', { name: FAKE_BANK_NAME });
    await expect(card).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Adicionar ligação' })).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByRole('link')).toHaveCount(0);
    // A 404 page (the loading boundary has already streamed, so the status is 200).
    await guest.goto('/connections/new');
    await expect(guest.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    await guest.goto('/connections');
    await shoot(guest, '81-connections-viewer');
    await ctx.close();
  });

  test('a tap on sign-in while the scripts are still arriving waits, then signs in', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT', serviceWorkers: 'block' });
    const slow = await ctx.newPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await slow.route(/\/_next\/static\/.*\.js(\?.*)?$/, async (route) => {
      await gate;
      await route.continue().catch(() => undefined);
    });
    try {
      // The page `load` event waits for the scripts, so only wait for the document.
      await slow.goto('/sign-in', { waitUntil: 'commit' });
      await slow.getByLabel('Email').fill(VIEWER.email);
      await slow.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
      const submit = slow.getByRole('button', { name: 'Entrar', exact: true });
      await expect(submit).toBeDisabled();
      const tap = submit.click();
      release();
      await tap;
      await expect(slow).toHaveURL(/\/$/);
      expect(slow.url()).not.toContain('password=');
    } finally {
      release();
      await slow.unrouteAll({ behavior: 'wait' });
      await ctx.close();
    }
  });

  test('review inbox: an AI suggestion comes first, with a badge and a word, never a percentage', async () => {
    const hid = await householdId();
    const [cat] = await sql<{ id: string }>(
      "select id from category where household_id = $1 and template_key = 'food.groceries'",
      [hid],
    );
    await sql(
      `update transaction set category_id = null, categorised_by = null, confidence = null,
         needs_review = true, ai_suggested_category_id = $2, ai_confidence = 0.78
       where household_id = $1 and counterparty = 'Continente Modelo'`,
      [hid, cat!.id],
    );
    await page.goto('/transactions/review');
    const article = page.getByRole('article', { name: 'Continente Modelo' });
    await expect(article.getByText('Sugestão da IA')).toBeVisible();
    await expect(article.getByText('Supermercado')).toBeVisible();
    await expect(article.getByText('Categorizado por IA')).toBeAttached();
    await expect(article.getByText('Sugestão provável')).toBeVisible();
    await expect(article).not.toContainText('%');
    await shoot(page, '82-review-ai', article);

    await article.getByRole('button', { name: 'Alterar' }).click();
    const picker = page.getByRole('dialog', { name: 'Escolher categoria' });
    const first = picker.getByRole('list').first().getByRole('button').first();
    await expect(first).toContainText('Supermercado');
    await expect(first).toContainText('provável');
    await expect(first).toContainText('IA');
    await expect(picker).not.toContainText('%');
    await page.keyboard.press('Escape');

    await article.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Categorizado como Supermercado')).toBeVisible();
    await expect(page.getByRole('article', { name: 'Continente Modelo' })).toHaveCount(0);
  });

  test('review inbox: an AI category applied below 0.85 shows how sure it was, a give-up says so', async () => {
    const hid = await householdId();
    const [cat] = await sql<{ id: string }>(
      "select id from category where household_id = $1 and template_key = 'food.groceries'",
      [hid],
    );
    const apply = (confidence: number) =>
      sql(
        `update transaction set category_id = $2, categorised_by = 'ai', confidence = $3,
           ai_confidence = $3, ai_suggested_category_id = null, needs_review = true,
           user_edited_at = null, updated_at = now()
         where household_id = $1 and counterparty = 'Padaria Central'`,
        [hid, cat!.id, confidence],
      );
    await apply(0.6);
    await page.goto('/transactions/review');
    const article = page.getByRole('article', { name: 'Padaria Central' });
    await expect(article.getByText('Supermercado')).toBeVisible();
    await expect(article.getByText('Categorizado por IA')).toBeAttached();
    await expect(article.getByText('Sugestão incerta')).toBeVisible();

    await apply(0);
    await page.goto('/transactions/review');
    const gaveUp = page.getByRole('article', { name: 'Padaria Central' });
    await expect(gaveUp.getByText('Sem certeza — colocado em Outros')).toBeVisible();
    await expect(gaveUp).not.toContainText('Sugestão');
  });

  test('AI-applied rows keep a badge, filter by origin and undo in one tap', async () => {
    const hid = await householdId();
    const [cat] = await sql<{ id: string }>(
      "select id from category where household_id = $1 and template_key = 'food.groceries'",
      [hid],
    );
    const applyAi = () =>
      sql(
        `update transaction set category_id = $2, categorised_by = 'ai', confidence = 0.93,
           ai_confidence = 0.93, ai_suggested_category_id = null, needs_review = false,
           user_edited_at = null, updated_at = now()
         where household_id = $1 and counterparty = 'Padaria Central'`,
        [hid, cat!.id],
      );
    await applyAi();

    await page.goto('/transactions?period=all');
    await expect(page.getByRole('button', { name: 'Categorizados por IA' })).toBeVisible();
    await page.getByRole('button', { name: 'Categorizados por IA' }).click();
    await expect(page).toHaveURL(/by=ai/);
    await expect(page.getByRole('button', { name: 'Origem: IA', pressed: true })).toBeVisible();
    const row = page.getByRole('button', { name: /^Padaria Central/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('Categorizado por IA').first()).toBeAttached();
    await expect(page.getByRole('button', { name: /Empresa Exemplo Lda/ })).toHaveCount(0);
    await shoot(page, '83-transactions-by-ai');

    const undo = page.getByRole('button', {
      name: 'Desfazer categorização da IA: Padaria Central',
    });
    await undo.click();
    await expect(page.getByText('Devolvido a Por rever')).toBeVisible();
    await expect(
      page.getByText('Nenhum movimento categorizado por IA neste período.'),
    ).toBeVisible();

    await page.goto('/transactions/review');
    const back = page.getByRole('article', { name: 'Padaria Central' });
    await expect(back.getByText('Sugestão da IA')).toBeVisible();
    await expect(back.getByText('Supermercado')).toBeVisible();

    // Edited by someone since the list was loaded: the undo is refused and says so.
    await applyAi();
    await page.goto('/transactions?by=ai&period=all');
    await expect(page.getByRole('button', { name: /^Padaria Central/ })).toBeVisible();
    await sql(
      "update transaction set user_edited_at = now() where household_id = $1 and counterparty = 'Padaria Central'",
      [hid],
    );
    await page
      .getByRole('button', { name: 'Desfazer categorização da IA: Padaria Central' })
      .click();
    await expect(
      page.getByText('Este movimento já foi alterado. Atualize a página.'),
    ).toBeVisible();

    // The detail says where the category came from, in words.
    await page.getByRole('button', { name: /^Padaria Central/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Detalhe do movimento' });
    await expect(sheet.getByText('Categorizado por IA').first()).toBeVisible();
    await expect(sheet).not.toContainText('%');
    await page.keyboard.press('Escape');

    // They left the inbox, but the inbox says how many and links to them.
    await page.goto('/transactions/review');
    const line = page.getByText(/A IA categorizou \d+ movimentos? nos últimos 30 dias\./);
    await expect(line).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver e corrigir' })).toHaveAttribute(
      'href',
      /by=ai/,
    );
  });

  test('settings: the AI section says exactly what is sent and the owner can switch it on and off', async () => {
    await page.goto('/settings/household');
    const section = page.getByRole('region', { name: 'IA: categorias e relatórios' });
    await expect(section).toContainText('descrição do movimento e contraparte');
    await expect(section).toContainText(
      'nomes de contas, IBAN, saldos de contas individuais, notas',
    );
    await expect(section).toContainText('nome de um comerciante ou de uma pessoa');
    await expect(section).toContainText(
      'Fornecedor: Anthropic · categorias: modelo claude-haiku-5-5 · relatórios: modelo claude-opus-5-5',
    );
    await expect(section).not.toContainText('tipo de conta');
    await expect(section).not.toContainText('nunca nomes');
    const toggle = section.getByRole('switch', { name: 'IA: categorias e relatórios' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await shoot(page, '84-settings-ai-off', section);

    await toggle.click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText(
        'IA ativada. As primeiras categorias aparecem dentro de uma hora e o relatório do último mês dentro de alguns minutos.',
      ),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await shoot(page, '85-settings-ai-on', section);

    await toggle.click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText(
        /Desativada\. As categorias já aplicadas mantêm-se e os relatórios existentes/,
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver categorizados por IA' })).toBeVisible();
  });

  test('loading and failing connection lists have their own states', async () => {
    // Loading: the connection table is locked, so the page streams its skeleton and waits.
    const locker = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await locker.connect();
    await locker.query('begin');
    await locker.query('lock table connection in access exclusive mode');
    const loading = page.goto('/connections').catch(() => undefined);
    // While the response streams in, React holds the resolved boundary in a hidden `div#S:n`
    // next to the fallback for a few milliseconds, so two loading statuses can exist at once.
    // What matters is that at least one is there: `.first()` keeps strict mode from failing on
    // that transient duplicate.
    await expect(
      page.locator('[aria-busy="true"]').getByText('A carregar…').first(),
    ).toBeAttached();
    await shoot(page, '86-connections-loading');
    await locker.query('commit');
    await locker.end();
    await loading;
    await expect(bank()).toBeVisible();

    // Error: the table is missing for a moment, so the page cannot load. Another tab, because
    // the browser logs the failed render as a console error.
    const failing = await page.context().newPage();
    await sql('alter table connection rename to connection_hold');
    try {
      await failing.goto('/connections');
      await expect(failing.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
      await shoot(failing, '87-connections-error');
    } finally {
      await sql('alter table connection_hold rename to connection');
      await failing.close();
    }
  });

  test('settings: without a server key the AI switch is off, disabled and says why', async () => {
    const other = await page.context().newPage();
    await other.goto(`${process.env.E2E_NOAI_URL}/settings/household`);
    const section = other.getByRole('region', { name: 'IA: categorias e relatórios' });
    const toggle = section.getByRole('switch', { name: 'IA: categorias e relatórios' });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(
      section.getByText('Indisponível: o servidor não tem uma chave de API de IA configurada.'),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-describedby', /.+/);
    // No key on the server: the provider and model line would be a promise nobody keeps.
    await expect(section).not.toContainText('Fornecedor');
    await shoot(other, '88-settings-ai-unavailable', section);
    await other.close();
  });

  test('no CSP violations, console errors or logo requests were logged', () => {
    expect(problems).toEqual([]);
  });
});
