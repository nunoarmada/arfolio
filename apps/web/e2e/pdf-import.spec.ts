import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { newOwnerContext, watch, signInOwner } from './helpers';
import { FAKE_ANTHROPIC_KEY, type FakeAnthropicRequest } from './fakes';

const PDF = fileURLToPath(new URL('./fixtures/statement.pdf', import.meta.url));
const ACCOUNT_A = 'Conta PDF A E2E';
const ACCOUNT_B = 'Conta PDF B E2E';
const SEND = 'Enviar e ler ficheiro';

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

// The fake Anthropic API lives in the runner's process; its counters are served over HTTP.
const fakeUrl = (path: string): string => `${process.env.E2E_FAKE_ANTHROPIC_URL}${path}`;
async function fakeState(): Promise<{ requests: number; last: FakeAnthropicRequest | null }> {
  const res = await fetch(fakeUrl('/__fake/state'));
  return (await res.json()) as { requests: number; last: FakeAnthropicRequest | null };
}
async function setFakeDelay(ms: number): Promise<void> {
  await fetch(fakeUrl('/__fake/delay'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ms }),
  });
}

/** Makes the fake answer with `count` generated movements; null restores the two fixed ones. */
async function setFakeRows(count: number | null): Promise<void> {
  await fetch(fakeUrl('/__fake/rows'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('PDF statement import with AI', () => {
  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let originalAiEnabled = false;
  let startedAt = new Date();
  let baseline = 0;
  const ids: Record<string, string> = {};
  const noAi = (path: string): string => `${process.env.E2E_NOAI_URL}${path}`;

  /** Requests the fake has answered since this spec started. */
  const requests = async (): Promise<number> => (await fakeState()).requests - baseline;

  async function addAccount(name: string): Promise<void> {
    await page.goto('/accounts');
    await page.getByRole('button', { name: 'Adicionar conta' }).click();
    const sheet = page.getByRole('dialog', { name: 'Adicionar conta' });
    await sheet.getByLabel('Nome', { exact: true }).fill(name);
    await sheet.getByLabel('Instituição').fill('Banco Exemplo');
    await sheet.getByLabel('Moeda').selectOption('EUR');
    await sheet.getByRole('button', { name: 'Guardar conta' }).click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}$/);
    ids[name] = page.url().split('/').pop()!;
  }

  async function clean(): Promise<void> {
    const accounts = await sql<{ id: string }>(
      `select id from financial_account where name like $1`,
      ['% PDF % E2E'],
    );
    const list = accounts.map((a) => a.id);
    if (list.length > 0) {
      await sql(`delete from transaction where account_id = any($1)`, [list]);
      await sql(`delete from import_batch where account_id = any($1)`, [list]);
      await sql(`delete from financial_account where id = any($1)`, [list]);
    }
    // Switching AI on and creating accounts may write audit rows: shared state other specs read.
    await sql(`delete from audit_log where created_at >= $1 and action like 'account.%'`, [
      startedAt,
    ]);
  }

  test.beforeAll(async ({ browser }) => {
    startedAt = new Date();
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    originalAiEnabled = (
      await sql<{ ai_enabled: boolean }>('select ai_enabled from household_settings limit 1')
    )[0]!.ai_enabled;
    await sql('update household_settings set ai_enabled = false');
    baseline = (await fakeState()).requests;
    await addAccount(ACCOUNT_A);
    await addAccount(ACCOUNT_B);
  });
  test.afterAll(async () => {
    // Every step runs even when an earlier one throws: the household is shared with other specs.
    const steps: (() => Promise<unknown>)[] = [
      () => sql('update household_settings set ai_enabled = $1', [originalAiEnabled]),
      () => setFakeDelay(0),
      () => setFakeRows(null),
      () => clean(),
      () => context?.close() ?? Promise.resolve(),
    ];
    const failures: unknown[] = [];
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  });

  test('with household AI off, choosing a PDF says it is not switched on and sends nothing', async () => {
    await page.goto(`/import?account=${ids[ACCOUNT_A]}`);
    await page.locator('#import-file').setInputFiles(PDF);
    await expect(page.getByTestId('chosen-file')).toHaveText('statement.pdf');
    await expect(page.getByTestId('pdf-unavailable')).toContainText('não está ativada');
    await expect(page.getByRole('button', { name: SEND })).toBeDisabled();
    expect(await requests()).toBe(0);
  });

  test('the owner switches household AI on in Settings', async () => {
    await page.goto('/settings/household');
    const section = page.getByRole('region', { name: 'IA: categorias e relatórios' });
    const toggle = section.getByRole('switch', { name: 'IA: categorias e relatórios' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText(/^IA ativada\./)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  test('the notice names Anthropic and sending the PDF lands on a checked preview', async () => {
    await page.goto(`/import?account=${ids[ACCOUNT_A]}`);
    await page.locator('#import-file').setInputFiles(PDF);
    await expect(page.getByTestId('pdf-notice')).toContainText('Anthropic');
    await expect(page.getByTestId('pdf-unavailable')).toHaveCount(0);
    expect(await requests()).toBe(0);

    await page.getByRole('button', { name: SEND }).click();
    await expect(page.getByTestId('pdf-source-line')).toContainText('Lido por IA');
    await expect(page.getByTestId('pdf-source-line')).toContainText('statement.pdf');
    await expect(page.getByTestId('stat-new')).toHaveText('2');
    await expect(page.getByRole('cell', { name: 'Grocer Example' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Refund, "Example" Shop' })).toBeVisible();
    expect(await requests()).toBe(1);

    // The contract with the provider: the installation key, the PDF as a document, no tools.
    const last = (await fakeState()).last;
    expect(last?.apiKey).toBe(FAKE_ANTHROPIC_KEY);
    expect(last?.documentMediaTypes).toEqual(['application/pdf']);
    expect(last?.hasTools).toBe(false);
  });

  test('Back keeps the extraction; changing the account asks for a new confirmation', async () => {
    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(page.getByRole('heading', { name: 'Colunas do ficheiro' })).toBeVisible();
    expect(await requests()).toBe(1);

    // Inverting the sign on the Columns step re-previews the extraction without a new request.
    const spend = page.getByRole('row', { name: /Grocer Example/ });
    const refund = page.getByRole('row', { name: /Refund/ });
    const invert = page.getByTestId('invert-sign');
    const proceed = page.getByRole('button', { name: 'Continuar' });
    await invert.check();
    // Until the live preview shows the new mapping, Continue cannot move on with the old rows.
    await expect(proceed).toBeDisabled();
    await expect(proceed).toBeEnabled();
    await expect(spend).toContainText(/(?<![-−]\s?)12,30/);
    await expect(refund).toContainText(/[-−]\s?5,00/);
    await proceed.click();
    await expect(page.getByTestId('stat-new')).toHaveText('2');
    await expect(spend).toContainText(/(?<![-−]\s?)12,30/);
    await expect(spend).not.toContainText(/[-−]\s?12,30/);
    await expect(refund).toContainText(/[-−]\s?5,00/);
    expect(await requests()).toBe(1);

    // Back to the original signs, so the import at the end keeps them.
    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(page.getByRole('heading', { name: 'Colunas do ficheiro' })).toBeVisible();
    await invert.uncheck();
    await expect(proceed).toBeDisabled();
    // No explicit wait for the live preview: Continue only becomes clickable once it is current.
    await proceed.click();
    await expect(spend).toContainText(/[-−]\s?12,30/);
    await expect(refund).not.toContainText(/[-−]\s?5,00/);
    expect(await requests()).toBe(1);

    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(page.getByRole('heading', { name: 'Colunas do ficheiro' })).toBeVisible();
    await page.getByRole('button', { name: 'Voltar' }).click();
    await expect(page.getByTestId('chosen-file')).toHaveText('statement.pdf');
    await expect(page.getByTestId('pdf-notice')).toContainText('Anthropic');
    await expect(page.getByRole('button', { name: SEND })).toBeEnabled();

    await page.getByLabel('Conta', { exact: true }).selectOption(ids[ACCOUNT_B]!);
    await expect(page.getByTestId('pdf-notice')).toContainText('Anthropic');
    await expect(page.getByRole('button', { name: SEND })).toBeEnabled();
    expect(await requests()).toBe(1);
  });

  test('the new confirmation reads the file again and the import lands in the chosen account', async () => {
    await page.getByRole('button', { name: SEND }).click();
    await expect(page.getByTestId('stat-new')).toHaveText('2');
    expect(await requests()).toBe(2);

    await page.getByRole('button', { name: 'Continuar' }).click();
    // A PDF has no file format of its own: the confirmation says how it was read.
    await expect(page.getByText('PDF lido por IA')).toBeVisible();
    await page.getByRole('button', { name: 'Importar 2 movimentos' }).click();
    await expect(page.getByRole('heading', { name: '2 movimentos importados.' })).toBeVisible();

    await page.goto(`/accounts/${ids[ACCOUNT_B]}`);
    await expect(page.getByText('Grocer Example')).toBeVisible();
    await expect(page.getByText('Refund, "Example" Shop')).toBeVisible();

    // The signs survived the round trip through the Columns step, and account A got nothing.
    const amounts = (id: string) =>
      sql<{ description: string; amount: string }>(
        'select raw_description as description, amount from transaction where account_id = $1 order by raw_description',
        [id],
      );
    expect(await amounts(ids[ACCOUNT_B]!)).toEqual([
      { description: 'Grocer Example', amount: '-1230' },
      { description: 'Refund, "Example" Shop', amount: '500' },
    ]);
    expect(await amounts(ids[ACCOUNT_A]!)).toEqual([]);
  });

  test('while the PDF is being read, the account and the file cannot be changed', async () => {
    await setFakeDelay(2_500);
    try {
      await page.goto(`/import?account=${ids[ACCOUNT_A]}`);
      await page.locator('#import-file').setInputFiles(PDF);
      await page.getByRole('button', { name: SEND }).click();
      await expect(page.getByLabel('Conta', { exact: true })).toBeDisabled();
      await expect(page.locator('#import-file')).toBeDisabled();
      await expect(page.getByText('A ler o extrato.')).toBeVisible();
      // The answer still arrives and lands on the preview of the account that was chosen.
      await expect(page.getByTestId('stat-new')).toHaveText('2');
    } finally {
      await setFakeDelay(0);
    }
  });

  test('every movement read from a PDF is in the preview, not only the first 50', async () => {
    await setFakeRows(60);
    try {
      await page.goto(`/import?account=${ids[ACCOUNT_A]}`);
      await page.locator('#import-file').setInputFiles(PDF);
      await page.getByRole('button', { name: SEND }).click();
      await expect(page.getByTestId('stat-new')).toHaveText('60');
      await expect(page.getByTestId('import-preview').locator('tbody tr')).toHaveCount(60);
      const last = page.getByRole('cell', { name: 'Movement 60 Example' });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      await expect(page.getByText(/A mostrar as primeiras/)).toHaveCount(0);
    } finally {
      await setFakeRows(null);
    }
  });

  // Reading waits for the model (its timeout copy); previewing does not (an interrupted connection).
  for (const [which, failing, message] of [
    ['reading the PDF', 1, 'O serviço de IA demorou demasiado a responder.'],
    ['previewing what was read', 2, 'A ligação foi interrompida. Tente novamente.'],
  ] as const) {
    test(`a connection cut while ${which} keeps the PDF and says to try again`, async () => {
      await page.goto(`/import?account=${ids[ACCOUNT_A]}`);
      await page.locator('#import-file').setInputFiles(PDF);
      let actions = 0;
      // Server actions are POSTs carrying a Next-Action header; the chosen one never answers.
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.method() === 'POST' && request.headers()['next-action']) {
          actions += 1;
          if (actions === failing) return route.abort('failed');
        }
        return route.continue();
      });
      try {
        await page.getByRole('button', { name: SEND }).click();
        await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
        await expect(page.getByTestId('chosen-file')).toHaveText('statement.pdf');
        await expect(page.getByRole('button', { name: SEND })).toBeEnabled();
      } finally {
        await page.unroute('**/*');
      }
    });
  }

  test('on an instance without an AI key, choosing a PDF says it is unavailable', async () => {
    const before = await requests();
    await page.goto(noAi(`/import?account=${ids[ACCOUNT_A]}`));
    await page.locator('#import-file').setInputFiles(PDF);
    await expect(page.getByTestId('pdf-unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: SEND })).toBeDisabled();
    expect(await requests()).toBe(before);
  });

  test('the household AI switch says PDF statements are sent whole, on confirmation', async () => {
    await page.goto('/settings/household');
    const section = page.getByRole('region', { name: 'IA: categorias e relatórios' });
    await expect(section).toContainText('Também lê extratos em PDF no assistente de importação.');
    await expect(section).toContainText(
      'Os extratos em PDF são enviados por inteiro, apenas quando alguém o confirma para esse ficheiro.',
    );
    await expect(section).toContainText('Nunca enviado nas categorias e nos relatórios:');
  });

  test('no CSP violations or console errors were logged', () => {
    expect(problems).toEqual([]);
  });
});
