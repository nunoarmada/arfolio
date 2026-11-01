import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { nativeSubmit } from './helpers';
import { saveState } from './state';
import { totp } from './totp';

const TOKEN = process.env.E2E_SETUP_TOKEN ?? '';
const BRAND = 'Casa Exemplo';
const PASSWORD = 'correct-horse-battery';
const OWNER = { name: 'Alex Example', email: 'alex@example.com' };
const INVITEE = { name: 'Sam Example', email: 'sam@example.com' };

/** Optional screenshots of every main state at phone and desktop widths. */
const SHOTS = process.env.E2E_SCREENSHOTS_DIR;
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const [label, size] of [
    ['mobile', { width: 390, height: 844 }],
    ['desktop', { width: 1440, height: 900 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}.png`, fullPage: false });
  }
  await page.setViewportSize(original);
}

/** Collects CSP violations and failed same-origin requests so the suite can assert there are none. */
function watch(page: Page, problems: string[]): void {
  page.on('console', (msg) => {
    const text = msg.text();
    // Chrome logs every 4xx (wrong password, wrong code, the 404 of a closed /setup) as a
    // console error; those are asserted through the UI and statuses, not here.
    if (/^Failed to load resource/.test(text)) return;
    if (msg.type() === 'error' || /content security policy|refused to/i.test(text)) {
      problems.push(`console ${msg.type()} at ${page.url()}: ${text}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
}

/** The visible alert (Next's route announcer is also role=alert and always present). */
const alertOf = (p: Page) => p.locator('[role=alert]:not(#__next-route-announcer__)');

async function signInForm(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('foundation', () => {
  const problems: string[] = [];
  let secret = '';
  let inviteLink = '';
  let page: Page;
  let browser: Browser;

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
    page = await b.newPage();
    watch(page, problems);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('health reports the database as up', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: true });
  });

  test('links the generated icons and social cards from the page head', async ({ request }) => {
    const html = await (await request.get('/sign-in')).text();
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="\/icon\.svg"/);
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"[^>]+href="\/icons\/apple"/);
    expect(html).toMatch(
      /<link[^>]+rel="mask-icon"[^>]+href="\/icons\/mask\.svg"[^>]+color="#2F5BC2"/,
    );
    expect(html).toMatch(/property="og:image" content="http:\/\/localhost:\d+\/og\?lang=pt-PT"/);
    expect(html).toMatch(/name="twitter:card" content="summary_large_image"/);
  });

  test('sends security headers and a nonce-based CSP', async ({ request }) => {
    const res = await request.get('/sign-in');
    const h = res.headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['strict-transport-security']).toContain('max-age=');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toContain('camera=()');
    const csp = h['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toContain("'unsafe-eval'");
    const body = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce && body.includes(`nonce="${nonce}"`)).toBeTruthy();
  });

  test('serves the PWA manifest, generated icons and the service worker', async ({ request }) => {
    const manifest = await (await request.get('/manifest.webmanifest')).json();
    expect(manifest).toMatchObject({ name: BRAND, display: 'standalone', start_url: '/' });
    const icon = await request.get('/icons/192');
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/png');
    // Every brand asset is generated at runtime: PNG size is read from the IHDR chunk.
    const pngSize = async (path: string) => {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['content-type'], path).toContain('image/png');
      const body = await res.body();
      return [body.readUInt32BE(16), body.readUInt32BE(20)];
    };
    expect(await pngSize('/icons/apple')).toEqual([180, 180]);
    expect(await pngSize('/icons/512')).toEqual([512, 512]);
    expect(await pngSize('/icons/maskable')).toEqual([512, 512]);
    expect(await pngSize('/icons/badge')).toEqual([96, 96]);
    expect(await pngSize('/og?lang=en')).toEqual([1200, 630]);
    expect(await pngSize('/og/twitter?lang=pt-PT')).toEqual([1200, 600]);
    const ico = await (await request.get('/favicon.ico')).body();
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([1, 3]);
    const svg = await request.get('/icon.svg');
    expect(svg.headers()['content-type']).toContain('image/svg+xml');
    expect(await svg.text()).toContain('#2F5BC2');
    expect((await request.get('/icons/nope')).status()).toBe(404);
    const sw = await request.get('/sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers()['content-type']).toContain('javascript');
  });

  test('Chromium reports no manifest or installability errors', async ({ page: fresh }) => {
    // Start URL "/" redirects anonymous visitors, so the check runs on the page they land on.
    await fresh.goto('/sign-in');
    await fresh.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const cdp = await fresh.context().newCDPSession(fresh);
    const app = (await cdp.send('Page.getAppManifest')) as { errors: { message: string }[] };
    expect(app.errors.map((e) => e.message)).toEqual([]);
    const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
      installabilityErrors: { errorId: string }[];
    };
    expect(installabilityErrors.map((e) => e.errorId)).toEqual([]);
  });

  test('anonymous visitors are sent to sign-in', async () => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await shoot(page, '01-sign-in');
  });

  test('rejects a wrong password with one generic message', async () => {
    await signInForm(page, OWNER.email);
    await expect(alertOf(page)).toHaveText('Email ou palavra-passe incorretos.');
  });

  test('sign-in submitted before hydration keeps the password out of the URL', async () => {
    const secret = 'pre-hydration-secret-1';
    const res = await nativeSubmit(browser, '/sign-in', async (p) => {
      await p.getByLabel('Email').fill(OWNER.email);
      const password = p.getByLabel('Palavra-passe', { exact: true });
      await password.fill(secret);
      // Layer one: the submit button is not usable until the page has hydrated ...
      await expect(p.getByRole('button', { name: 'Entrar', exact: true })).toBeDisabled();
      // ... layer two: a submit that gets through anyway (autofill, an old browser) is a POST.
      await password.evaluate((el) => (el as HTMLInputElement).form!.requestSubmit());
    });
    expect(res.url).not.toContain('password=');
    expect(res.url).not.toContain(secret);
    expect(res.urls.filter((u) => u.includes('password=') || u.includes(secret))).toEqual([]);
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain(secret);
  });

  test('setup with the token creates the owner and forces two-step enrolment', async () => {
    const setupRes = await page.goto(`/setup?token=${TOKEN}`);
    expect(setupRes?.headers()['referrer-policy']).toBe('no-referrer');
    // The valid token is read, hidden and removed from the address bar.
    await expect(page.getByLabel('Código de configuração')).toHaveCount(0);
    await expect(page).toHaveURL(/\/setup$/);
    await shoot(page, '02-setup-household');

    await page.getByLabel('Nome do agregado').fill(BRAND);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByText('Passo 2 de 3')).toBeVisible();
    await page.getByLabel('Nome', { exact: true }).fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Confirmar palavra-passe').fill(PASSWORD);
    await shoot(page, '03-setup-account');
    await page.getByRole('button', { name: 'Criar agregado e conta' }).click();

    await expect(page).toHaveURL(/\/two-factor\/setup$/);
    await expect(
      page.getByRole('heading', { name: 'Ativar a verificação em dois passos', level: 1 }),
    ).toBeVisible();
  });

  test('an owner without 2FA cannot reach the app shell', async () => {
    await page.goto('/settings/members');
    await expect(page).toHaveURL(/\/two-factor\/setup$/);
  });

  test('enrols TOTP, confirms it and shows ten recovery codes', async () => {
    await page.getByLabel('Palavra-passe atual').fill('wrong-password');
    await page.getByRole('button', { name: 'Gerar código' }).click();
    await expect(alertOf(page)).toHaveText('Palavra-passe incorreta.');

    await page.getByLabel('Palavra-passe atual').fill(PASSWORD);
    await page.getByRole('button', { name: 'Gerar código' }).click();
    await expect(page.getByAltText('Código QR para a aplicação de autenticação')).toBeVisible();
    secret = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    saveState({ totpSecret: secret });
    await shoot(page, '04-2fa-setup-scan');
    await page.getByRole('button', { name: 'Continuar' }).click();

    // A wrong code is refused, the right one moves on to the recovery codes.
    await page.getByLabel('Código de 6 dígitos').fill('000000');
    await expect(alertOf(page)).toContainText('Código incorreto');
    await page.getByLabel('Código de 6 dígitos').fill(totp(secret));
    await expect(
      page.getByRole('heading', { name: 'Códigos de recuperação', level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Códigos de recuperação' }).getByRole('listitem'),
    ).toHaveCount(10);
    await shoot(page, '05-2fa-setup-recovery');

    const finish = page.getByRole('button', { name: 'Concluir' });
    await expect(finish).toBeDisabled();
    await page.getByLabel('Guardei os códigos num local seguro').check();
    await finish.click();
  });

  test('home renders the shell with the brand name and the empty state', async () => {
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();
    await expect(page.getByRole('complementary').getByText(BRAND)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ainda não há contas.' })).toBeVisible();
    await expect(page).toHaveTitle(`Início · ${BRAND}`);
    await shoot(page, '06-home');
  });

  test('signs out, then signs in with a TOTP challenge', async () => {
    await page.getByRole('button', { name: /Menu da conta/ }).click();
    await page.getByRole('menuitem', { name: 'Terminar sessão' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await signInForm(page, OWNER.email);
    await expect(page).toHaveURL(/\/two-factor$/);
    await shoot(page, '07-2fa-challenge');
    // Use the next 30 s window's code: accepted (+-1 step) and never a replay of the enrolment code.
    await page.getByLabel('Código de 6 dígitos').fill(totp(secret, Date.now() + 30_000));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();
  });

  test('setup is gone (404) once an account exists', async () => {
    const res = await page.goto('/setup');
    expect(res?.status()).toBe(404);
    const withToken = await page.goto(`/setup?token=${TOKEN}`);
    expect(withToken?.status()).toBe(404);
  });

  test('owner edits the household settings', async () => {
    await page.goto('/settings');
    await shoot(page, '08-settings-index');
    await page.getByRole('link', { name: /^Agregado/ }).click();
    await expect(page.getByRole('heading', { name: 'Agregado', level: 1 })).toBeVisible();
    await page.getByLabel('Nome do agregado').fill('Casa Exemplo Nova');
    await page.getByLabel('Moeda').selectOption('USD');
    await expect(page.getByText(/Exemplo: .*1\s234,56/)).toBeVisible();
    await page.getByLabel('Aumentar meses').click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Alterações guardadas')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Moeda')).toHaveValue('USD');
    await expect(page.getByLabel('Nome do agregado')).toHaveValue('Casa Exemplo Nova');
    await expect(page.getByLabel('Fundo de emergência (meses)')).toHaveValue('7');
    await shoot(page, '09-settings-household');
  });

  test('branding preview shows the configured colour and derived contrast', async () => {
    await page.goto('/settings/branding');
    await expect(page.getByText('Definido na configuração do servidor.')).toBeVisible();
    await expect(page.getByText('#2F5BC2').first()).toBeVisible();
    await expect(page.getByText(/Texto do botão \d+,\d:1/).first()).toBeVisible();
    await shoot(page, '10-settings-branding');
  });

  test('security page lists the session and 2FA status', async () => {
    await page.goto('/settings/security');
    await expect(page.getByText(/Ativa\. Pede um código/)).toBeVisible();
    await expect(page.getByText(/\(Esta sessão\)/)).toBeVisible();
    await shoot(page, '11-settings-security');
  });

  test('change-password submitted before hydration keeps both passwords out of the URL', async () => {
    const current = 'pre-hydration-current-2';
    const next = 'pre-hydration-next-3';
    const res = await nativeSubmit(
      browser,
      '/settings/security',
      async (p) => {
        const form = p.getByRole('region', { name: 'Alterar palavra-passe' });
        await form.getByLabel('Palavra-passe atual').fill(current);
        const nextField = form.getByLabel('Nova palavra-passe');
        await nextField.fill(next);
        await expect(form.getByRole('button', { name: 'Alterar palavra-passe' })).toBeDisabled();
        await nextField.evaluate((el) => (el as HTMLInputElement).form!.requestSubmit());
      },
      await page.context().storageState(),
    );
    for (const secretValue of [current, next, 'current=', 'next=']) {
      expect(res.url).not.toContain(secretValue);
      expect(res.urls.filter((u) => u.includes(secretValue))).toEqual([]);
    }
    expect(res.status).toBeLessThan(500);
    expect(res.body).not.toContain(current);
    expect(res.body).not.toContain(next);
  });

  test('owner invites sam@example.com and sees the one-time link', async () => {
    await page.goto('/settings/members');
    await page.getByLabel('Email').fill(INVITEE.email);
    await page.getByLabel('Função').selectOption('member');
    await page.getByRole('button', { name: 'Criar convite' }).click();
    const link = page.getByLabel('Link do convite');
    await expect(link).toBeVisible();
    inviteLink = await link.inputValue();
    expect(inviteLink).toMatch(/\/invite\/[^?]+\?t=[\w-]{20,}$/);
    await expect(page.getByText(INVITEE.email).first()).toBeVisible();
    await shoot(page, '12-members-invited');
  });

  test('the invitee opens the link in a fresh context and joins as a member', async () => {
    const ctx = await browser.newContext({ locale: 'pt-PT' });
    const guest = await ctx.newPage();
    watch(guest, problems);
    const res = await guest.goto(inviteLink);
    expect(res?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(guest.getByRole('heading', { name: 'Convite para o agregado' })).toBeVisible();
    await expect(guest.getByText(/convidou-o para o agregado/)).toContainText('membro');
    // The token leaves the address bar once the form holds it.
    await expect.poll(() => guest.url()).not.toContain('t=');
    await expect(guest.getByLabel('Email')).toHaveValue(INVITEE.email);
    await shoot(guest, '13-invite');

    await guest.getByLabel('Nome').fill(INVITEE.name);
    await guest.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
    await guest.getByRole('button', { name: 'Aceitar e criar conta' }).click();
    await expect(guest).toHaveURL(/\/$/);
    await expect(guest.getByRole('heading', { name: 'Início', level: 1 })).toBeVisible();

    // Same household, member role: the list shows both, with no management controls.
    await guest.goto('/settings/members');
    const list = guest.getByRole('region', { name: 'Membros do agregado' });
    await expect(list.getByText(OWNER.name)).toBeVisible();
    await expect(list.getByText(INVITEE.name)).toBeVisible();
    await expect(
      guest.getByText('Só os proprietários podem convidar ou remover membros.'),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Criar convite' })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: /^Remover/ })).toHaveCount(0);
    await expect(guest.getByRole('heading', { name: 'Convites pendentes' })).toHaveCount(0);
    await shoot(guest, '14-members-as-member');

    // The spent link no longer works.
    await guest.goto(inviteLink);
    await expect(
      guest.getByRole('heading', { name: 'Este convite já não é válido' }),
    ).toBeVisible();

    // Language switch: nav labels change to English.
    await guest.goto('/settings/preferences');
    await guest.getByRole('button', { name: 'English' }).click();
    await expect(guest.getByRole('link', { name: 'Home' }).first()).toBeVisible();
    await expect(guest.getByRole('link', { name: 'Settings' }).first()).toBeVisible();
    await expect(guest.locator('html')).toHaveAttribute('lang', 'en');
    await shoot(guest, '15-preferences-en');
    await ctx.close();
  });

  test('owner sees the member, then revokes another invitation', async () => {
    await page.goto('/settings/members');
    await expect(
      page.getByRole('region', { name: 'Membros do agregado' }).getByText(INVITEE.name),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Convites pendentes' })).toBeVisible();
    await expect(page.getByText('Não há convites pendentes.')).toBeVisible();

    await page.getByLabel('Email').fill('z@example.com');
    await page.getByRole('button', { name: 'Criar convite' }).click();
    const revokedLink = await page.getByLabel('Link do convite').inputValue();
    await expect(page.getByText('z@example.com').first()).toBeVisible();
    await page.getByRole('button', { name: 'Revogar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revogar convite' }).click();
    await expect(page.getByText('Convite revogado')).toBeVisible();
    await expect(page.getByText('Não há convites pendentes.')).toBeVisible();

    const other = await browser.newContext();
    const guest = await other.newPage();
    await guest.goto(revokedLink);
    await expect(
      guest.getByRole('heading', { name: 'Este convite já não é válido' }),
    ).toBeVisible();
    await other.close();
  });

  test('dark theme renders the shell', async () => {
    await page.goto('/settings/preferences');
    // Click the visible label: the radio itself is sr-only, which makes a forced check flaky.
    await page
      .locator('label')
      .filter({ hasText: /^Escuro$/ })
      .click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shoot(page, '16-preferences-dark');
    await page.goto('/');
    await shoot(page, '17-home-dark');
    await page.goto('/settings/branding');
    await shoot(page, '18-branding-dark');
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
