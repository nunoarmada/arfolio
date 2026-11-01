import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import pg from 'pg';
import { PASSWORD, axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

const VIEWER = { email: 'vic@example.com' };
// A made-up key: it only has to look like one. Nothing here ever calls Anthropic with it.
const FAKE_KEY = 'sk-ant-e2e-fake-key-8f3a9c1d';

/** Runs SQL as the database owner (bypasses RLS): inspection and cleanup only, never the app. */
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

async function axeBoth(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function expectNoOverflow(page: Page, width: number, label: string): Promise<void> {
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll, `${label}: scrollWidth > ${overflow.client}`).toBeLessThanOrEqual(
    overflow.client,
  );
  await page.setViewportSize(original);
}

test.describe('Settings > Services', () => {
  test.describe.configure({ mode: 'serial' });

  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let originalAiEnabled = false;
  // The main server has the Anthropic key from its environment, so the key flow runs on the
  // second instance of the same build (same database, no key in its environment).
  const noAi = (path: string): string => `${process.env.E2E_NOAI_URL}${path}`;
  const actionResponses: string[] = [];

  const ai = (p: Page = page): Locator => p.getByRole('region', { name: 'IA', exact: true });
  const bank = (p: Page = page): Locator =>
    p.getByRole('region', { name: 'Ligações bancárias', exact: true });
  const keyInput = (p: Page = page): Locator =>
    ai(p).getByLabel('Chave de API da Anthropic', { exact: true });

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    page.on('response', (res) => {
      if (res.request().headers()['next-action']) {
        void res.text().then(
          (t) => actionResponses.push(t),
          () => undefined,
        );
      }
    });
    await signInOwner(page);
    originalAiEnabled = (
      await sql<{ ai_enabled: boolean }>('select ai_enabled from household_settings limit 1')
    )[0]!.ai_enabled;
    await sql('update household_settings set ai_enabled = false');
    await sql(`delete from instance_secret where name like 'setting:%'`);
  });
  test.afterAll(async () => {
    await sql(`delete from instance_secret where name like 'setting:%'`);
    // Saving and removing settings writes audit rows; they are shared state, and phase 6 expects
    // the household's activity list to start empty.
    await sql(`delete from audit_log where target_type = 'instance_setting'`);
    await sql('update household_settings set ai_enabled = $1', [originalAiEnabled]);
    await context.close();
  });
  test.afterEach(async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('the owner finds Serviços in the settings index and sub-nav', async () => {
    await page.goto('/settings');
    const link = page.getByRole('main').getByRole('link', { name: /Serviços/ });
    await expect(link).toContainText('IA, ligações bancárias e email desta instalação');
    await link.click();
    await expect(page).toHaveURL(/\/settings\/services$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Serviços' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Secções das definições' })).toContainText(
      'Serviços',
    );
  });

  test('a setting from the environment is read-only and says so', async () => {
    await page.goto('/settings/services');
    await expect(ai().getByText(/Valor definido por variável de ambiente\./)).toBeVisible();
    await expect(keyInput()).toHaveCount(0);
    await expect(ai().getByRole('button', { name: /Substituir|Remover/ })).toHaveCount(0);
    // Read-only text (not an input) with the lock note.
    await expect(bank().getByLabel('ID da aplicação', { exact: true })).toHaveText('e2e-app-id');
    await expect(bank().getByRole('textbox', { name: 'ID da aplicação' })).toHaveCount(0);
    await expect(bank().getByRole('button', { name: 'Guardar' })).toHaveCount(0);
  });

  test('the bank card shows the redirect URL and tests the connection with the resolved credentials', async () => {
    await page.goto('/settings/services');
    const callback = `${new URL(page.url()).origin}/api/connections/callback`;
    await expect(bank().getByText(callback, { exact: true })).toBeVisible();
    await expect(bank().getByRole('button', { name: 'Copiar endereço' })).toBeVisible();
    await bank().getByRole('button', { name: 'Testar a ligação bancária' }).click();
    await expect(bank().getByText('A Enable Banking aceitou as credenciais.')).toBeVisible();
    await shoot(page, 'S1-services-bank', bank());
  });

  test('saving a key shows "Valor guardado", enables AI in the household settings, and never shows the key again', async () => {
    await page.goto(noAi('/settings/services'));
    await expect(keyInput()).toBeVisible();
    await expect(ai().getByRole('button', { name: 'Testar a chave de API' })).toBeDisabled();
    await shoot(page, 'S2-services-ai-empty', ai());

    // Keyboard only: type the key and submit with Enter.
    await keyInput().focus();
    await page.keyboard.type(FAKE_KEY);
    await page.keyboard.press('Enter');
    await expect(ai().getByText(/Valor guardado · atualizado em /)).toBeVisible();
    await expect(keyInput()).toHaveCount(0);
    await expect(
      ai().getByRole('button', { name: 'Substituir Chave de API da Anthropic' }),
    ).toBeVisible();
    await shoot(page, 'S3-services-ai-configured', ai());

    // The key travelled in the request only: no response, no page and no row carries it.
    expect(actionResponses.join('\n')).not.toContain(FAKE_KEY);
    expect(await page.content()).not.toContain(FAKE_KEY);
    const rows = await sql<{ name: string; value: string }>(
      `select name, value from instance_secret where name = 'setting:anthropic.apiKey'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).not.toContain(FAKE_KEY);
    const audit = await sql<{ action: string; target_id: string }>(
      `select action, target_id from audit_log where target_type = 'instance_setting' order by created_at`,
    );
    expect(audit.at(-1)).toEqual({
      action: 'instance_setting.update',
      target_id: 'anthropic.apiKey',
    });
    expect(JSON.stringify(audit)).not.toContain(FAKE_KEY);

    // The household switch can now be turned on.
    await ai().getByRole('link', { name: 'Ativar a IA nas definições do agregado' }).click();
    await expect(page).toHaveURL(/\/settings\/household#ai$/);
    const section = page.getByRole('region', { name: 'IA: categorias e relatórios' });
    const toggle = section.getByRole('switch', { name: 'IA: categorias e relatórios' });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText(/IA ativada\./)).toBeVisible();

    // Reload: the key is not in the page, only the fact that it is configured.
    await page.goto(noAi('/settings/services'));
    await expect(ai().getByText(/Valor guardado · atualizado em /)).toBeVisible();
    expect(await page.content()).not.toContain(FAKE_KEY);
    await expect(
      page
        .locator('input, textarea')
        .evaluateAll((els) => els.some((el) => (el as HTMLInputElement).value.includes('sk-ant-'))),
    ).resolves.toBe(false);
  });

  test('replacing asks for a new value and removing asks first', async () => {
    await page.goto(noAi('/settings/services'));
    await ai().getByRole('button', { name: 'Substituir Chave de API da Anthropic' }).click();
    await expect(keyInput()).toBeFocused();
    await expect(keyInput()).toHaveValue('');
    await ai().getByRole('button', { name: 'Cancelar' }).click();
    await expect(keyInput()).toHaveCount(0);

    await ai().getByRole('button', { name: 'Remover Chave de API da Anthropic' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Remover Chave de API da Anthropic?');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(ai().getByText(/Valor guardado · atualizado em /)).toBeVisible();
  });

  test('invalid values are explained next to the field and nothing is stored', async () => {
    await page.goto(noAi('/settings/services'));
    // The bank settings come from the environment on this instance too, so they are read-only;
    // the portals have no environment variable.
    await expect(bank().getByRole('textbox', { name: 'Endereço da API' })).toHaveCount(0);
    await ai().getByText('Avançado', { exact: true }).click();
    const portals = ai().getByLabel('Imóveis', { exact: true });
    await portals.fill('bad host!');
    await ai().getByRole('button', { name: 'Guardar' }).last().click();
    await expect(
      ai().getByText(
        'Verifique os endereços: um por linha, como idealista.pt, até 20 em cada lista.',
      ),
    ).toBeVisible();
    const stored = await sql(
      `select 1 from instance_secret where name = 'setting:ai.valuationPortals'`,
    );
    expect(stored).toHaveLength(0);

    await portals.fill('Idealista.pt\nimovirtual.com\nidealista.pt');
    await ai().getByRole('button', { name: 'Guardar' }).last().click();
    await expect(page.getByText('Guardado', { exact: true })).toBeVisible();
    await expect(ai().getByRole('button', { name: 'Usar os predefinidos' })).toBeVisible();
  });

  test('desktop and phone layouts have no overflow and pass axe', async () => {
    await page.goto(noAi('/settings/services'));
    await expect(ai().getByText(/Valor guardado · atualizado em /)).toBeVisible();
    await axeBoth(page, 'services (desktop)');
    await expectNoOverflow(page, 375, 'services at 375px');
    await expectNoOverflow(page, 320, 'services at 320px');
    await shoot(page, 'S4-services-full');
  });

  test('removing the key puts the field back and AI goes unavailable again', async () => {
    await page.goto(noAi('/settings/services'));
    await ai().getByRole('button', { name: 'Remover Chave de API da Anthropic' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remover', exact: true })
      .click();
    await expect(page.getByText('Removido', { exact: true })).toBeVisible();
    await expect(keyInput()).toBeVisible();
    await expect(
      await sql(`select 1 from instance_secret where name = 'setting:anthropic.apiKey'`),
    ).toHaveLength(0);
    const audit = await sql<{ action: string; target_id: string }>(
      `select action, target_id from audit_log where target_type = 'instance_setting' order by created_at`,
    );
    expect(audit.at(-1)).toEqual({
      action: 'instance_setting.remove',
      target_id: 'anthropic.apiKey',
    });
  });

  test('a viewer does not see the section and cannot open it', async ({ browser }) => {
    const headers = { ...(test.info().project.use.extraHTTPHeaders ?? {}) };
    const ctx = await browser.newContext({ locale: 'pt-PT', extraHTTPHeaders: headers });
    const guest = await ctx.newPage();
    watch(guest, problems);
    await guest.goto('/sign-in');
    await guest.getByLabel('Email').fill(VIEWER.email);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(guest).toHaveURL(/\/$/);

    await guest.goto('/settings');
    await expect(guest.getByRole('main').getByRole('link', { name: /Serviços/ })).toHaveCount(0);
    await expect(guest.getByRole('main').getByRole('link', { name: /Claude & MCP/ })).toBeVisible();
    // The page streams after its loading state, so the 404 page is what proves it (not the status).
    await guest.goto('/settings/services');
    await expect(
      guest.getByRole('heading', { level: 1, name: 'Página não encontrada' }),
    ).toBeVisible();
    await expect(guest.getByText('Chave de API da Anthropic')).toHaveCount(0);
    await ctx.close();
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
