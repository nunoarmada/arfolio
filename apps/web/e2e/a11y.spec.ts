import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations as violations, signInOwner } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('accessibility: no serious or critical axe violations', () => {
  let page: Page;
  let connectionId = '';

  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ locale: 'pt-PT' })).newPage();
    await signInOwner(page);
    const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
    await client.connect();
    try {
      const rows = await client.query<{ id: string }>(
        "select id from connection where provider = 'enablebanking'",
      );
      connectionId = rows.rows[0]!.id;
    } finally {
      await client.end();
    }
  });
  test.afterAll(async () => {
    await page.context().close();
  });

  const pages: Array<[string, () => string]> = [
    ['connections', () => '/connections'],
    ['link accounts', () => `/connections/${connectionId}/link`],
    ['review inbox', () => '/transactions/review'],
    ['settings (AI section)', () => '/settings/household'],
  ];

  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, url] of pages) {
      test(`${name}, ${scheme}`, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(url());
        await page.waitForLoadState('networkidle');
        expect(await violations(page)).toEqual([]);
      });
    }
  }
});
