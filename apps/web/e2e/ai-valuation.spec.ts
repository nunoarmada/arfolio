import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { axeViolations, newOwnerContext, shoot, signInOwner, watch } from './helpers';

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

const setHouseholdAi = (on: boolean) => sql('update household_settings set ai_enabled = $1', [on]);

test.describe.configure({ mode: 'serial' });

// Asset details, the AI valuation switch and the estimate on the asset's page. No model is called:
// the worker does not run here, so the estimate is seeded the way the worker would store it. The
// asset is named apart from phase4's ("Apartamento") and removed at the end, since this project
// may run before or beside the phases that list the household's assets.
test.describe('AI asset valuation', () => {
  const problems: string[] = [];
  let context: BrowserContext;
  let page: Page;
  let assetId = '';

  test.beforeAll(async ({ browser }) => {
    context = await newOwnerContext(browser);
    page = await context.newPage();
    watch(page, problems);
    await signInOwner(page);
    await setHouseholdAi(true);
  });

  test.afterAll(async () => {
    // Other projects share this household and count its assets: leave nothing behind (the
    // asset's valuations go with it).
    if (assetId) await sql('delete from asset where id = $1', [assetId]);
    await setHouseholdAi(false);
    await context.close();
  });

  test('the form lists what is missing, then saves details and the switch', async () => {
    await page.goto('/net-worth/assets/new?kind=real_estate');
    await page.getByLabel('Nome', { exact: true }).fill('Moradia IA em Lisboa');
    await expect(page.getByRole('group', { name: 'Detalhes' })).toBeVisible();
    const aiSwitch = page.getByRole('switch', { name: 'Estimar o valor automaticamente com IA' });
    await expect(aiSwitch).toBeEnabled();
    await expect(aiSwitch).not.toBeChecked();
    await aiSwitch.click();
    await expect(aiSwitch).toBeChecked();
    await expect(
      page.getByText('Para estimar faltam: Tipo de imóvel, Concelho, Área útil.'),
    ).toBeVisible();
    await shoot(page, 'ai-form-missing', aiSwitch);

    await page.getByLabel('Tipo de imóvel').selectOption({ label: 'Apartamento' });
    await page.getByLabel('Concelho').fill('Lisboa');
    await page.getByLabel('Área útil (m²)').fill('85,5');
    await expect(page.getByText(/^Para estimar faltam/)).toHaveCount(0);
    await page.getByLabel('Código postal').fill('1234');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(
      page.getByText('Indique o código postal no formato 1000-001.', { exact: true }).last(),
    ).toBeVisible();
    await shoot(page, 'ai-form-invalid');
    await page.getByLabel('Código postal').fill('1000-001');
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Ativo criado')).toBeVisible();
    await expect(page).toHaveURL(/\/net-worth\/assets\/[0-9a-f-]{36}$/);
    assetId = new URL(page.url()).pathname.split('/').at(-1)!;

    const [row] = await sql<{ ai_valuation: boolean; details: Record<string, unknown> }>(
      'select ai_valuation, details from asset where id = $1',
      [assetId],
    );
    expect(row!.ai_valuation).toBe(true);
    expect(row!.details).toEqual({
      propertyType: 'apartment',
      municipality: 'Lisboa',
      areaM2: 85.5,
      postalCode: '1000-001',
    });
  });

  test('the page shows the request as pending and the details summary', async () => {
    await page.goto(`/net-worth/assets/${assetId}`);
    await expect(
      page.getByText('Estimativa pedida — fica pronta em poucos minutos.'),
    ).toBeVisible();
    const details = page.getByRole('region', { name: 'Detalhes' });
    await expect(details).toContainText('Apartamento');
    await expect(details).toContainText('85,5');
    await shoot(page, 'ai-asset-queued');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('a stored estimate shows its range, confidence, rationale and sources', async () => {
    await sql(
      `insert into asset_valuation (household_id, asset_id, as_of, value, method, note, estimate)
       select household_id, id, current_date, 20000000, 'ai', $2, $3::jsonb from asset where id = $1`,
      [
        assetId,
        'Três anúncios comparáveis na mesma zona, entre 2 300 e 2 500 €/m².',
        JSON.stringify({
          low: 18000000,
          high: 22000000,
          confidence: 'medium',
          sources: [
            { title: 'Idealista · T2 em Arroios', url: 'https://www.idealista.pt/imovel/1' },
            { title: '', url: 'https://www.imovirtual.com/anuncio/2' },
            { title: 'Nao e web', url: 'javascript:alert(1)' },
          ],
        }),
      ],
    );
    await sql('update asset set ai_requested_at = null where id = $1', [assetId]);
    await page.goto(`/net-worth/assets/${assetId}`);
    await expect(page.getByText(/^Estimativa IA de /)).toBeVisible();
    const estimate = page.getByRole('region', { name: 'Estimativa IA' });
    await expect(estimate).toContainText(/Entre 180\D000,00.* e 220\D000,00/);
    await expect(estimate).toContainText('Confiança média');
    await expect(estimate).toContainText('Três anúncios comparáveis');
    const links = estimate.getByRole('link');
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute('target', '_blank');
    await expect(links.first()).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(links.first()).toContainText('Idealista · T2 em Arroios');
    await expect(links.first()).toContainText('idealista.pt');
    await expect(links.nth(1)).toContainText('imovirtual.com');
    await expect(page.getByText('A IA atualiza este valor todos os meses.')).toBeVisible();
    // The history names the method.
    await expect(page.getByText('Estimativa IA', { exact: true }).first()).toBeVisible();
    await shoot(page, 'ai-asset-estimate');
    expect(await axeViolations(page)).toEqual([]);

    await page.goto('/net-worth');
    await expect(page.getByTestId(`nw-item-${assetId}`)).toContainText(/Estimativa IA · /);
  });

  test('"Estimar agora" queues a new estimate', async () => {
    await page.goto(`/net-worth/assets/${assetId}`);
    await page.getByRole('button', { name: 'Estimar agora' }).click();
    await expect(page.getByText('Estimativa pedida. Fica pronta em poucos minutos.')).toBeVisible();
    await expect(
      page.getByText('Estimativa pedida — fica pronta em poucos minutos.'),
    ).toBeVisible();
    const [row] = await sql<{ ai_requested_at: Date | null }>(
      'select ai_requested_at from asset where id = $1',
      [assetId],
    );
    expect(row!.ai_requested_at).not.toBeNull();
  });

  test('the last failure is explained', async () => {
    await sql(
      `update asset set ai_requested_at = null, ai_last_error = 'insufficient_data' where id = $1`,
      [assetId],
    );
    await page.goto(`/net-worth/assets/${assetId}`);
    await expect(page.getByText(/não encontrou anúncios comparáveis suficientes/)).toBeVisible();
    await shoot(page, 'ai-asset-error');
  });

  test('with household AI off the switch is disabled and points to the settings', async () => {
    await setHouseholdAi(false);
    await page.goto(`/net-worth/assets/${assetId}`);
    await expect(page.getByText(/A IA está desligada para este agregado/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Estimar agora' })).toHaveCount(0);
    await shoot(page, 'ai-asset-household-off');

    await page.goto(`/net-worth/assets/new?kind=vehicle`);
    const aiSwitch = page.getByRole('switch', { name: 'Estimar o valor automaticamente com IA' });
    await expect(aiSwitch).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Ligar nas definições' })).toHaveAttribute(
      'href',
      '/settings/household#ai',
    );
    await shoot(page, 'ai-form-household-off', aiSwitch);
    await setHouseholdAi(true);
  });

  test('a vehicle trades its depreciation field for the AI switch', async () => {
    await page.goto('/net-worth/assets/new?kind=vehicle');
    await expect(page.getByLabel('Depreciação anual (%)')).toBeVisible();
    await page.getByRole('switch', { name: 'Estimar o valor automaticamente com IA' }).click();
    await expect(page.getByLabel('Depreciação anual (%)')).toHaveCount(0);
    await expect(
      page.getByText(/^Para estimar faltam: Tipo de veículo, Marca, Modelo/),
    ).toBeVisible();
    await shoot(page, 'ai-form-vehicle');
  });

  test('cash and investments have no details and no AI switch', async () => {
    await page.goto('/net-worth/assets/new?kind=cash');
    await expect(page.getByRole('group', { name: 'Detalhes' })).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);
  });

  test('no console errors or CSP violations', () => {
    expect(problems).toEqual([]);
  });
});
