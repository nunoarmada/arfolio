import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { PASSWORD, axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

const VIEWER = { email: 'vic@example.com' };
const OWNER = { email: 'alex@example.com' };
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const SCOPES = 'openid profile email offline_access pfm:read pfm:write';
const TOKEN = /^pfm_pat_[A-Za-z0-9_-]{43}$/;
const BASE = process.env.E2E_BASE_URL!;
const MCP = `${BASE}/api/mcp`;
const PAGE = '/settings/integrations';

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
const userId = async (email: string): Promise<string> =>
  (await sql<{ id: string }>('select id from "user" where email = $1', [email]))[0]!.id;
const auditActions = async (action: string): Promise<number> =>
  (
    await sql<{ n: number }>('select count(*)::int as n from audit_log where action = $1', [action])
  )[0]!.n;

/** One JSON-RPC call to the MCP endpoint, as a client holding `token` would make it. */
async function rpc(
  request: APIRequestContext,
  token: string | null,
  method: string,
  params: unknown = {},
): Promise<{ status: number; body: { result?: { isError?: boolean }; error?: unknown } | null }> {
  const res = await request.post('/api/mcp', {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  const text = await res.text();
  const payload = res.headers()['content-type']?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    : text;
  let body = null;
  try {
    body = JSON.parse(payload);
  } catch {
    // not JSON (an error page): the status says it
  }
  return { status: res.status(), body };
}
const listAccounts = (request: APIRequestContext, token: string) =>
  rpc(request, token, 'tools/call', { name: 'list_accounts', arguments: {} });

/** Both colour schemes, axe-clean (serious and critical violations). */
async function axeBoth(page: Page, label: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeViolations(page), `${label} (${scheme})`).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The page never scrolls sideways at 320px, whatever is open on it. */
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

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClaude(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/oauth2/register', {
    headers: { origin: BASE },
    data: {
      client_name: 'Claude',
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_type: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPES,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The browser, signed in, is sent from the authorization endpoint to the consent page. */
async function startAuthorize(page: Page, clientId: string, challenge: string): Promise<void> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: SCOPES,
    state: 'xyz',
    resource: MCP,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  await page.goto(`/api/auth/oauth2/authorize?${query}`);
  await expect(page).toHaveURL(/\/oauth\/consent\?/);
}

/**
 * claude.ai is not reachable from the test: the browser's navigation to the callback is
 * recorded (not followed) and its URL returned.
 */
async function callbackAfter(page: Page, action: () => Promise<void>): Promise<URL> {
  await page.route('https://claude.ai/**', (route) => route.abort());
  const request = page.waitForRequest(/claude\.ai\/api\/mcp\/auth_callback/);
  await action();
  return new URL((await request).url());
}

async function signInViewer(browser: Browser): Promise<{ ctx: BrowserContext; guest: Page }> {
  const ctx = await newOwnerContext(browser);
  const guest = await ctx.newPage();
  await guest.goto('/sign-in');
  await guest.getByLabel('Email').fill(VIEWER.email);
  await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
  await guest.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(guest).toHaveURL(/\/$/);
  return { ctx, guest };
}

test.describe.configure({ mode: 'serial' });

test.describe('phase 6: integrations (MCP)', () => {
  const problems: string[] = [];
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let hid: string;
  let ownerId: string;
  let viewerId: string;

  const toast = () => page.locator('.toast-region');
  const sheet = () => page.getByRole('dialog', { name: 'Criar token' });
  const reveal = () => page.getByRole('dialog', { name: 'Token criado' });
  const tokenRows = () => page.getByTestId('token-list').getByRole('listitem');

  async function clean() {
    await sql('delete from personal_access_token');
    await sql('delete from oauth_consent');
    await sql('delete from oauth_refresh_token');
    await sql('delete from oauth_access_token');
    await sql(
      // rule.create and account.delete come from earlier projects (rules-holdings, phase1).
      `delete from audit_log where action in ('pat.create','pat.revoke','consent.revoke','rule.create','account.delete')`,
    );
  }

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    context = await newOwnerContext(b);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    hid = await householdId();
    ownerId = await userId(OWNER.email);
    viewerId = await userId(VIEWER.email);
    await clean();
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

  test('is in the settings index and sub-nav, and starts with the guide open and every list empty', async () => {
    await page.goto('/settings');
    const link = page.getByRole('link', { name: /Claude & MCP/ }).first();
    await expect(link).toContainText('Ligar o Claude e outros assistentes de IA');
    // Right after Segurança.
    const labels = await page.getByRole('main').getByRole('link').allTextContents();
    const at = labels.findIndex((l) => l.startsWith('Segurança'));
    expect(labels[at + 1]).toMatch(/^Claude & MCP/);
    await link.click();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Integrações (MCP)' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Secções das definições' })).toContainText(
      'Claude & MCP',
    );

    const guide = page.locator('#integrations-guide');
    await expect(guide).toHaveAttribute('open', '');
    await expect(guide.getByRole('heading', { name: 'Como ligar' })).toBeVisible();
    await expect(guide.getByLabel('Endereço do servidor MCP')).toHaveValue(MCP);
    await expect(guide.getByText('sem redirecionamentos')).toBeVisible();
    // claude.ai's own menu names stay in English.
    await expect(guide.locator('strong', { hasText: 'Settings › Connectors' })).toBeVisible();
    await expect(guide.locator('strong', { hasText: 'Add custom connector' })).toBeVisible();
    // The command carries the literal placeholder and the brand as the server name.
    await expect(guide.getByTestId('guide-command')).toHaveText(
      `claude mcp add --transport http casa-exemplo ${MCP} --header "Authorization: Bearer <token>"`,
    );
    await guide.getByRole('button', { name: 'Copiar comando' }).click();
    await expect(guide.getByText('Copiado').first()).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Bearer <token>');

    await expect(
      page.getByRole('heading', { level: 2, name: 'Tokens de acesso pessoal' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Aplicações ligadas' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Atividade recente' })).toBeVisible();
    await expect(page.getByText('Crie um token para ligar o Claude Code')).toBeVisible();
    await expect(page.getByText('Quando permitir o acesso a uma aplicação')).toBeVisible();
    await expect(page.getByText('Ainda não há atividade.')).toBeVisible();
    // The brand is the installation's, never the product default.
    await expect(page.getByRole('main')).not.toContainText('Arfolio');
    await shoot(page, 'F1-integrations-empty');
    await axeBoth(page, 'integrations (empty)');
    await expectNoOverflowAt320(page, 'integrations (empty)');
  });

  test('creates a token, shows it once, and the token works until it is revoked', async ({
    request,
  }) => {
    await page.goto(PAGE);
    await page.locator('#create-token-button').click();
    await expect(sheet()).toBeVisible();
    await expect(sheet().getByLabel('Nome')).toBeFocused();
    // Least privilege and a 90-day expiry are preselected.
    await expect(sheet().getByRole('radio', { name: /^Só leitura/ })).toBeChecked();
    await expect(sheet().getByRole('radio', { name: '90 dias' })).toBeChecked();
    await expect(sheet().getByRole('radio', { name: /^Leitura e escrita/ })).toBeEnabled();

    await sheet().getByRole('radio', { name: 'Sem validade' }).check();
    await expect(sheet().getByText('só deixa de funcionar quando o revogar')).toBeVisible();
    await shoot(page, 'F2-create-sheet');
    await axeBoth(page, 'create sheet');
    await expectNoOverflowAt320(page, 'create sheet');
    await sheet().getByRole('radio', { name: '90 dias' }).check();

    // Name is required.
    await sheet().getByRole('button', { name: 'Criar token' }).click();
    await expect(sheet().getByText('Indique um nome.')).toBeVisible();
    await expect(sheet().getByLabel('Nome')).toBeFocused();
    expect(await sql('select 1 from personal_access_token')).toHaveLength(0);

    await sheet().getByLabel('Nome').fill('Portátil do trabalho');
    await sheet().getByRole('button', { name: 'Criar token' }).click();

    // The reveal dialog replaces the sheet: warning first, the token, two copy actions.
    await expect(reveal()).toBeVisible();
    await expect(sheet()).toHaveCount(0);
    await expect(reveal().getByText('não voltará a ser mostrado')).toBeVisible();
    const token = (await reveal().getByTestId('revealed-token').textContent())!.trim();
    expect(token).toMatch(TOKEN);
    await expect(reveal().getByRole('button', { name: 'Copiar token' })).toBeFocused();
    await expect(reveal().getByText('Token «Portátil do trabalho»')).toBeVisible();
    await shoot(page, 'F3-reveal');
    await axeBoth(page, 'reveal dialog');
    await expectNoOverflowAt320(page, 'reveal dialog');

    // A click outside does not lose the only copy of the token.
    await page.mouse.click(4, 4);
    await expect(reveal()).toBeVisible();
    await reveal().getByRole('button', { name: 'Copiar comando do Claude Code' }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(
      `claude mcp add --transport http casa-exemplo ${MCP} --header "Authorization: Bearer ${token}"`,
    );
    await reveal().getByRole('button', { name: 'Copiar token' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

    await reveal().getByRole('button', { name: 'Já guardei o token' }).click();
    await expect(reveal()).toHaveCount(0);
    await expect(toast().getByText('Token criado')).toBeVisible();
    await expect(page.locator('#create-token-button')).toBeFocused();
    // The token is gone from the page, and the list has the row (prefix only).
    expect(await page.content()).not.toContain(token);
    await expect(tokenRows()).toHaveCount(1);
    const row = tokenRows().first();
    await expect(row).toContainText('Portátil do trabalho');
    await expect(row).toContainText('Só leitura');
    await expect(row).toContainText(`${token.slice(0, 12)}…`);
    await expect(row).toContainText('Nunca usado');
    await expect(row).toContainText(/Expira a /);
    expect(await auditActions('pat.create')).toBe(1);
    const stored = await sql<{ scope: string; name: string }>(
      'select scope, name from personal_access_token',
    );
    expect(stored).toEqual([{ scope: 'read', name: 'Portátil do trabalho' }]);

    // The token works from a client.
    const ok = await listAccounts(request, token);
    expect(ok.status).toBe(200);
    expect(ok.body?.result?.isError ?? false).toBe(false);
    await page.reload();
    await expect(tokenRows().first()).toContainText('Último uso');

    // A populated page, in both themes and at 320px.
    await expect(page.locator('#integrations-guide')).not.toHaveAttribute('open', '');
    await shoot(page, 'F4-integrations-token');
    await axeBoth(page, 'integrations (token)');
    await expectNoOverflowAt320(page, 'integrations (token)');

    // Revoke: confirm, then the row collapses, focus goes to the heading, the call gets 401.
    await page.getByRole('button', { name: 'Revogar o token Portátil do trabalho' }).click();
    const dialog = page.getByRole('alertdialog', {
      name: 'Revogar o token «Portátil do trabalho»?',
    });
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expect(dialog).toContainText('perdem o acesso de imediato');
    await shoot(page, 'F5-revoke-token');
    await axeBoth(page, 'revoke dialog');
    await dialog.getByRole('button', { name: 'Revogar token' }).click();
    await expect(toast().getByText('Token revogado')).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Tokens de acesso pessoal' }),
    ).toBeVisible();
    await expect(page.locator('#tokens-title')).toBeFocused();
    expect((await listAccounts(request, token)).status).toBe(401);
    expect(await auditActions('pat.revoke')).toBe(1);
    await page.reload();
    await expect(page.getByTestId('token-list')).toHaveCount(0);
  });

  test('lists expiring, expired and open-ended tokens; an expired one is removed without asking', async () => {
    const seed = async (name: string, scope: string, expires: string | null, used: string | null) =>
      sql(
        `insert into personal_access_token (household_id, user_id, name, token_hash, prefix, scope, expires_at, last_used_at)
         values ($1, $2, $3, $4, $5, $6, ${expires ? `now() + interval '${expires}'` : 'null'}, ${used ? `now() - interval '${used}'` : 'null'})`,
        [hid, ownerId, name, randomBytes(32), `pfm_pat_${randomBytes(2).toString('hex')}`, scope],
      );
    await seed('Sem fim com um nome comprido para quebrar a linha', 'read_write', null, '2 hours');
    await seed('Quase a expirar', 'read', '3 days', null);
    await seed('Expirado', 'read', '-2 days', '5 days');
    await seed('Mensal', 'read', '40 days', null);
    await page.goto(PAGE);
    // The page streams in behind a loading skeleton and React reveals it on a later frame, possibly
    // after the load event; evaluateAll does not wait, so wait for the rows before reading them.
    await expect(tokenRows()).toHaveCount(4);
    const names = await tokenRows().evaluateAll((rows) =>
      rows.map((r) => r.querySelector('p')!.firstElementChild!.textContent),
    );
    // Newest first among the live ones; the expired one last.
    expect(names.at(-1)).toBe('Expirado');
    expect(names).toHaveLength(4);
    const soon = tokenRows().filter({ hasText: 'Quase a expirar' });
    await expect(soon).toContainText('Expira dentro de 3 dias');
    await expect(soon.getByText('Expira dentro de 3 dias')).toHaveClass(/text-warning/);
    const open = tokenRows().filter({ hasText: 'Sem fim' });
    await expect(open).toContainText('Leitura e escrita');
    await expect(open).toContainText('Sem validade');
    await expect(open).toContainText('Último uso');
    const dead = tokenRows().filter({ hasText: 'Expirado' });
    await expect(dead).toContainText('Expirou a ');
    await expect(dead).toContainText('Expirado');
    await shoot(page, 'F6-token-states');
    await axeBoth(page, 'token states');
    await expectNoOverflowAt320(page, 'token states');

    await page.getByRole('button', { name: 'Remover o token expirado Expirado' }).click();
    await expect(toast().getByText('Token removido')).toBeVisible();
    await expect(tokenRows()).toHaveCount(3);
    expect(
      await sql(
        `select 1 from personal_access_token where name = 'Expirado' and revoked_at is not null`,
      ),
    ).toHaveLength(1);
    await sql('delete from personal_access_token');
    await sql(`delete from audit_log where action = 'pat.revoke'`);
  });

  test('a viewer can only create a read token, and sees no activity', async () => {
    const { ctx, guest } = await signInViewer(browser);
    try {
      await guest.goto(PAGE);
      await expect(
        guest.getByRole('heading', { level: 1, name: 'Integrações (MCP)' }),
      ).toBeVisible();
      await expect(guest.getByRole('heading', { name: 'Atividade recente' })).toHaveCount(0);
      await guest.locator('#create-token-button').click();
      const dialog = guest.getByRole('dialog', { name: 'Criar token' });
      const write = dialog.getByRole('radio', { name: /^Leitura e escrita/ });
      await expect(write).toBeDisabled();
      await expect(write).toHaveAccessibleDescription(
        /Indisponível: a sua função só permite consultar/,
      );
      await expect(dialog.getByRole('radio', { name: /^Só leitura/ })).toBeChecked();
      await shoot(guest, 'F7-create-viewer');
      await axeBoth(guest, 'create sheet (viewer)');
      // Not only a disabled radio: a forged request asking for read_write is refused by the server.
      await guest.route(
        (url) => url.pathname === PAGE,
        (route) => {
          const body = route.request().postData() ?? '';
          return route.request().method() === 'POST' && body.includes('"scope":"read"')
            ? route.continue({ postData: body.replace('"scope":"read"', '"scope":"read_write"') })
            : route.continue();
        },
      );
      await dialog.getByLabel('Nome').fill('Forjado');
      await dialog.getByRole('button', { name: 'Criar token' }).click();
      await expect(dialog.getByText('Não foi possível criar o token')).toBeVisible();
      expect(await sql('select 1 from personal_access_token')).toHaveLength(0);
      await guest.unrouteAll({ behavior: 'ignoreErrors' });
      await dialog.getByLabel('Nome').fill('Só para ver');
      await dialog.getByRole('button', { name: 'Criar token' }).click();
      const done = guest.getByRole('dialog', { name: 'Token criado' });
      await expect(done).toBeVisible();
      expect((await done.getByTestId('revealed-token').textContent())!.trim()).toMatch(TOKEN);
      await done.getByRole('button', { name: 'Já guardei o token' }).click();
      await expect(guest.getByTestId('token-list').getByRole('listitem')).toHaveCount(1);
      const rows = await sql<{ scope: string; user_id: string }>(
        'select scope, user_id from personal_access_token',
      );
      expect(rows).toEqual([{ scope: 'read', user_id: viewerId }]);
    } finally {
      await ctx.close();
      await sql('delete from personal_access_token');
      await sql(`delete from audit_log where action = 'pat.create'`);
    }
  });

  test('the consent page renders, and Deny sends access_denied back to the client', async ({
    request,
  }) => {
    const clientId = await registerClaude(request);
    const { challenge } = pkce();
    await startAuthorize(page, clientId, challenge);
    await expect(page.getByRole('heading', { level: 1, name: 'Permitir acesso' })).toBeVisible();
    await expect(page.getByText('quer ligar-se a Casa Exemplo')).toBeVisible();
    await expect(page.getByText('claude.ai').first()).toBeVisible();
    const scopes = page.getByRole('region', { name: 'Poderá' });
    await expect(scopes).toContainText(
      'Consultar contas, movimentos, orçamento e património do agregado',
    );
    await expect(scopes).toContainText(
      'Criar e categorizar movimentos, criar regras e registar valores de ativos',
    );
    await expect(scopes).toContainText('Concedido:');
    await expect(
      page.getByText('Pode revogar este acesso em Definições › Integrações (MCP).'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Permitir', exact: true })).toBeEnabled();
    await shoot(page, 'F8-consent');
    await axeBoth(page, 'consent');
    await expectNoOverflowAt320(page, 'consent');

    // On phones Permitir is on top; from sm up Recusar is on the left.
    await page.setViewportSize({ width: 390, height: 844 });
    const allow = await page.getByRole('button', { name: 'Permitir', exact: true }).boundingBox();
    const deny = await page.getByRole('button', { name: 'Recusar', exact: true }).boundingBox();
    expect(allow!.y).toBeLessThan(deny!.y);
    await page.setViewportSize({ width: 1280, height: 800 });
    const allowD = await page.getByRole('button', { name: 'Permitir', exact: true }).boundingBox();
    const denyD = await page.getByRole('button', { name: 'Recusar', exact: true }).boundingBox();
    expect(denyD!.x).toBeLessThan(allowD!.x);

    const back = await callbackAfter(page, () =>
      page.getByRole('button', { name: 'Recusar', exact: true }).click(),
    );
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('code')).toBeNull();
    expect(await sql('select 1 from oauth_consent')).toHaveLength(0);
  });

  test('an invalid consent request explains itself and leads home', async () => {
    await page.goto(
      '/oauth/consent?client_id=unknown&redirect_uri=https%3A%2F%2Fevil.example%2Fcb',
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Este pedido não é válido' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Voltar ao início' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('allowing an app lists it under Aplicações ligadas; revoking it cuts its token off at once', async ({
    request,
  }) => {
    const clientId = await registerClaude(request);
    const { verifier, challenge } = pkce();
    await startAuthorize(page, clientId, challenge);
    const callback = await callbackAfter(page, () =>
      page.getByRole('button', { name: 'Permitir', exact: true }).click(),
    );
    const code = callback.searchParams.get('code');
    expect(code).toBeTruthy();
    const exchanged = await request.post('/api/auth/oauth2/token', {
      form: {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP,
      },
    });
    expect(exchanged.status(), await exchanged.text()).toBe(200);
    const { access_token: accessToken } = (await exchanged.json()) as { access_token: string };
    expect((await listAccounts(request, accessToken)).status).toBe(200);

    await page.goto(PAGE);
    await expect(page.locator('#integrations-guide')).not.toHaveAttribute('open', '');
    const apps = page.getByTestId('app-list').getByRole('listitem');
    await expect(apps).toHaveCount(1);
    await expect(apps.first()).toContainText('Claude');
    await expect(apps.first()).toContainText('Leitura e escrita');
    await expect(apps.first()).toContainText('Ligada a ');
    await shoot(page, 'F9-connected-app');
    await axeBoth(page, 'connected apps');
    await expectNoOverflowAt320(page, 'connected apps');

    await page.getByRole('button', { name: 'Revogar o acesso de Claude' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revogar o acesso de Claude?' });
    await expect(dialog).toContainText('terá de autorizar o acesso de novo');
    await axeBoth(page, 'revoke app dialog');
    await dialog.getByRole('button', { name: 'Revogar acesso' }).click();
    await expect(toast().getByText('Acesso revogado')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Aplicações ligadas' })).toBeVisible();
    await expect(page.locator('#apps-title')).toBeFocused();

    expect((await listAccounts(request, accessToken)).status).toBe(401);
    expect(await sql('select 1 from oauth_consent')).toHaveLength(0);
    expect(await sql('select 1 from oauth_refresh_token')).toHaveLength(0);
    const audit = await sql<{ actor: string; credential: string; user_id: string }>(
      `select actor, credential, user_id from audit_log where action = 'consent.revoke'`,
    );
    expect(audit).toEqual([{ actor: 'web', credential: `oauth:${clientId}`, user_id: ownerId }]);
  });

  test('recent activity (owners) reads each row in words: who, how and when', async () => {
    const pat = await sql<{ id: string }>(
      `insert into personal_access_token (household_id, user_id, name, token_hash, prefix, scope)
       values ($1, $2, 'Token do Claude Code', $3, 'pfm_pat_0000', 'read_write') returning id`,
      [hid, ownerId, randomBytes(32)],
    );
    await sql(
      `insert into audit_log (household_id, user_id, actor, action, target_type, credential)
       values ($1, $2, 'mcp', 'rule.create', 'rule', $3),
              ($1, $2, 'mcp', 'rule.create', 'rule', $4),
              ($1, null, 'mcp', 'something.new', null, null)`,
      [hid, ownerId, `pat:${pat[0]!.id}`, 'pat:00000000-0000-4000-8000-000000000000'],
    );
    await sql(
      `insert into audit_log (household_id, user_id, actor, action, created_at)
       values ($1, $2, 'web', 'pat.create', now() - interval '3 days'),
              ($1, $2, 'web', 'account.delete', now() - interval '2 days')`,
      [hid, ownerId],
    );
    try {
      await page.goto(PAGE);
      const list = page.getByTestId('activity-list');
      await expect(list.getByRole('listitem').first()).toBeVisible();
      await expect(list).toContainText('Regra criada via MCP');
      await expect(list).toContainText('Conta apagada');
      await expect(list).toContainText('Alex');
      await expect(list).toContainText('através do token «Token do Claude Code»');
      await expect(list).toContainText('através de um token apagado');
      await expect(list).toContainText('Ação registada (something.new)');
      await expect(list).toContainText('Utilizador removido');
      await expect(list).toContainText('na aplicação web');
      // Recent rows are relative; older ones carry a date and time.
      await expect(list.locator('time').first()).toHaveText(/agora|há/);
      await expect(list.locator('time').last()).toHaveText(/\d{1,2}.*\d{2}:\d{2}/);
      await expect(list.locator('time').first()).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      await shoot(page, 'F10-activity', list);
      await axeBoth(page, 'activity');
      await expectNoOverflowAt320(page, 'activity');
    } finally {
      await sql('delete from personal_access_token');
      await sql(
        `delete from audit_log where action in ('rule.create','something.new','pat.create','account.delete')`,
      );
    }
  });

  test('has no console errors or CSP violations', () => {
    expect(problems).toEqual([]);
  });
});
