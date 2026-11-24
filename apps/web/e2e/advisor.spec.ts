import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations, newOwnerContext, signInOwner, watch } from './helpers';

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

// The streamed answer the fake Anthropic API gives after the advisor's first tool call.
const ADVICE = 'Example advice';
const noAi = (path: string): string => `${process.env.E2E_NOAI_URL}${path}`;

test.describe.configure({ mode: 'serial' });

test.describe('Financial advisor', () => {
  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let originalAiEnabled = false;

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    originalAiEnabled = (
      await sql<{ ai_enabled: boolean }>('select ai_enabled from household_settings limit 1')
    )[0]!.ai_enabled;
    await sql('update household_settings set ai_enabled = true');
  });

  test.afterAll(async () => {
    await sql('delete from advisor_proposal');
    await sql('delete from advisor_note');
    await sql('delete from advisor_message');
    await sql('delete from advisor_member_settings');
    await sql(`delete from audit_log where action like 'advisor.%'`);
    await sql(`delete from notification where kind = 'advisor_message'`);
    await sql('update household_settings set ai_enabled = $1', [originalAiEnabled]);
    await context?.close();
  });

  test('the launcher opens the window, streams an answer and Escape returns focus', async () => {
    await page.goto('/');
    const launcher = page.getByRole('button', { name: /^Abrir consultor/ });
    await expect(launcher).toBeVisible();
    await launcher.click();

    const dialog = page.getByRole('dialog', { name: /^Consultor / });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('group', { name: 'Perguntas sugeridas' })
      .getByRole('button')
      .first()
      .click();

    await expect(dialog.getByRole('log')).toContainText(ADVICE);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  });

  test('the conversation is stored for the member and nothing leaks to the page as errors', async () => {
    const rows = await sql<{ role: string }>(
      'select role from advisor_message order by created_at',
    );
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(problems).toEqual([]);
  });

  test('/advisor has no serious axe violations', async () => {
    await page.goto('/advisor');
    await expect(page.getByRole('log')).toContainText(ADVICE);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await axeViolations(page), `/advisor (${scheme})`).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: 'light' });
  });

  test('without an API key there is no launcher and /advisor shows the AI-off state', async () => {
    await page.goto(noAi('/'));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Abrir consultor/ })).toHaveCount(0);

    await page.goto(noAi('/advisor'));
    await expect(page.getByText('A IA está desligada neste agregado')).toBeVisible();
  });
});
