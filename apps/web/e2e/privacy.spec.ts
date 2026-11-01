import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { newOwnerContext, signInOwner, watch } from './helpers';

/** A formatted pt-PT euro amount ("1 240,00 €", "−35,00 €"), as the app writes them. */
const AMOUNT = /\d,\d{2}\s€/;

/**
 * Clicks the privacy switch and waits until the server has stored the new setting. It waits on the
 * cookie, not on the action's response: that response also streams the re-rendered page, which can
 * take long, while the cookie is set in its headers.
 */
async function toggleAndSave(page: Page, name: string, expected: 'on' | 'off'): Promise<void> {
  await page.getByRole('button', { name }).click();
  await expect
    .poll(async () => (await page.context().cookies()).find((c) => c.name === 'privacy')?.value)
    .toBe(expected);
}

test.describe('privacy mode', () => {
  test.describe.configure({ mode: 'serial' });

  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
  });

  test.afterAll(async () => {
    await context.close();
  });

  test('hides every amount, survives a reload, and shows them again', async () => {
    await page.goto('/accounts');
    const main = page.locator('main');
    await expect(main).toContainText(AMOUNT);

    const hide = page.getByRole('button', { name: 'Esconder montantes' });
    await expect(hide).toHaveAttribute('aria-pressed', 'false');
    await toggleAndSave(page, 'Esconder montantes', 'on');

    const show = page.getByRole('button', { name: 'Mostrar montantes' });
    await expect(show).toHaveAttribute('aria-pressed', 'true');
    await expect(main).toContainText('•••• €');
    await expect(main).not.toContainText(AMOUNT);

    // The server renders the first HTML already masked: no amount flashes in before hydration.
    const response = await page.reload();
    expect(await response!.text()).not.toMatch(AMOUNT);
    await expect(main).toContainText('•••• €');
    await expect(page.getByRole('button', { name: 'Mostrar montantes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await toggleAndSave(page, 'Mostrar montantes', 'off');
    await expect(main).toContainText(AMOUNT);
    await page.reload();
    await expect(main).toContainText(AMOUNT);
    expect(problems).toEqual([]);
  });
});
