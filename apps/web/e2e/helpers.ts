import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { loadState } from './state';
import { totp } from './totp';

/** Optional screenshots of every main state: phone and desktop, light and dark. */
const SHOTS = process.env.E2E_SCREENSHOTS_DIR;

/** `focus` is scrolled into view at every size, for states that sit below the fold. */
export async function shoot(page: Page, name: string, focus?: Locator): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const original = page.viewportSize() ?? { width: 1280, height: 800 };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [
      ['mobile', { width: 390, height: 844 }],
      ['desktop', { width: 1280, height: 800 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(250);
      await focus?.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${name}-${label}-${scheme}.png`, fullPage: false });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(original);
}

/** Collects CSP violations and console errors so a suite can assert there are none. */
export function watch(page: Page, problems: string[]): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (/^Failed to load resource/.test(text)) return;
    if (msg.type() === 'error' || /content security policy|refused to/i.test(text)) {
      problems.push(`console ${msg.type()} at ${page.url()}: ${text}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
}

export const OWNER_EMAIL = 'alex@example.com';
export const PASSWORD = 'correct-horse-battery';

/** Signs in with the owner's TOTP secret from the foundation spec (codes are single-use). */
export async function signInOwner(page: Page): Promise<void> {
  const secret = loadState().totpSecret;
  expect(secret, 'the foundation spec saves the TOTP secret').toBeTruthy();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByLabel('Palavra-passe', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/two-factor$/);
  for (const offset of [0, 30_000, -30_000]) {
    await page.getByLabel('Código de 6 dígitos').fill(totp(secret!, Date.now() + offset));
    try {
      await expect(page).toHaveURL(/\/$/, { timeout: 8_000 });
      return;
    } catch {
      // That window was already used or not accepted: try the next one.
    }
  }
  throw new Error('no TOTP code was accepted');
}

/**
 * Resolves when the page has taken on the emulated colour scheme and every finite transition
 * and animation has finished. Axe measures contrast from computed colours, so running it while
 * a colour or opacity transition (next-themes flips the `dark` class, `transition-colors`) or a
 * sheet's slide/fade is half done compares colours that are neither theme's.
 */
export async function waitForSettledPage(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    if (document.documentElement.classList.contains('dark') !== dark) return false;
    return document.getAnimations().every((a) => {
      // Looping animations (skeleton pulse, spinners) never finish and are not a transition.
      if (a.effect?.getTiming().iterations === Infinity) return true;
      return a.playState === 'finished' || a.playState === 'idle';
    });
  });
}

/** Serious and critical axe violations only (WCAG 2.0 to 2.2 A and AA), as readable text. */
export async function axeViolations(page: Page): Promise<string[]> {
  await waitForSettledPage(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ` +
        v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(' ') + ' | ' + (n.failureSummary ?? '').split('\n').join(' '))
          .join('\n  '),
    );
}

/**
 * The owner's browser context for a spec's `beforeAll`. `browser.newContext()` does not inherit
 * the project's `extraHTTPHeaders`, so it is passed on here (the project's x-real-ip keeps its
 * sign-ins in its own rate-limit window). With `--repeat-each`, every repeat signs in again, so
 * each repeat gets its own loopback address (127.<repeat>.0.<project>) and its own window.
 */
export async function newOwnerContext(browser: Browser): Promise<BrowserContext> {
  const info = test.info();
  const headers = { ...(info.project.use.extraHTTPHeaders ?? {}) };
  const ip = headers['x-real-ip'];
  if (ip && info.repeatEachIndex > 0) {
    const last = ip.split('.').pop();
    headers['x-real-ip'] = `127.${info.repeatEachIndex}.0.${last}`;
  }
  return browser.newContext({ locale: 'pt-PT', extraHTTPHeaders: headers });
}

/**
 * Loads `path` in a fresh context with the app's scripts blocked, so React never hydrates and a
 * submit is the browser's own: what a slow phone does when the user taps before the JS has
 * arrived. Service workers are off so they cannot answer the blocked requests from a cache.
 * Returns every URL requested and the status and body of the document the submit landed on.
 */
export async function nativeSubmit(
  browser: Browser,
  path: string,
  fillAndSubmit: (p: Page) => Promise<void>,
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>,
): Promise<{ url: string; urls: string[]; status: number | null; body: string }> {
  const ctx = await browser.newContext({ locale: 'pt-PT', serviceWorkers: 'block', storageState });
  try {
    const p = await ctx.newPage();
    const urls: string[] = [];
    await p.route(/\/_next\/static\/.*\.js(\?.*)?$/, (route) => route.abort());
    try {
      await p.goto(path);
      p.on('request', (r: Request) => urls.push(r.url()));
      const landed = p.waitForResponse(
        (r) => r.request().isNavigationRequest() && r.frame() === p.mainFrame(),
      );
      await fillAndSubmit(p);
      const response = await landed;
      await p.waitForLoadState('load');
      const body = await response.text();
      return { url: response.url(), urls, status: response.status(), body };
    } finally {
      await p.unrouteAll({ behavior: 'wait' });
    }
  } finally {
    await ctx.close();
  }
}
