import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { APP_LOCALES, resolveAppLocale, type AppLocale } from '@arfolio/core';
import { schema, withHousehold, type Db, type Tx } from '@arfolio/db';
import { assertCanWrite, type ServiceCtx } from './context.js';

const { category, categoryGroup, householdSettings, organization } = schema;

/** One template set per app locale. */
export const TEMPLATE_LOCALES = APP_LOCALES;
export type TemplateLocale = AppLocale;

/** The template set for any locale tag: its own language's, else English ("pt-BR" gets pt-PT). */
export function resolveTemplateLocale(locale: string): TemplateLocale {
  return resolveAppLocale(locale);
}

type Names = Record<TemplateLocale, string>;
interface TemplateGroup {
  key: string;
  kind: schema.CategoryGroupKind;
  name: Names;
  categories: Array<{ key: string; name: Names }>;
}

/** Every name supplies all five locales, so a missing translation fails the type check. */
const n = (ptPT: string, esES: string, frFR: string, itIT: string, en: string): Names => ({
  'pt-PT': ptPT,
  'es-ES': esES,
  'fr-FR': frFR,
  'it-IT': itIT,
  en,
});

/** Template keys are stable identifiers: renaming a seeded row never makes seeding re-add it. */
export const TRANSFER_CATEGORY_KEY = 'transfer.between_accounts';

export const CATEGORY_TEMPLATES: readonly TemplateGroup[] = [
  {
    key: 'income',
    kind: 'income',
    name: n('Receitas', 'Ingresos', 'Revenus', 'Entrate', 'Income'),
    categories: [
      { key: 'income.salary', name: n('Salário', 'Nómina', 'Salaire', 'Stipendio', 'Salary') },
      {
        key: 'income.benefits',
        name: n(
          'Subsídios e apoios',
          'Prestaciones y ayudas',
          'Allocations et aides',
          'Sussidi e contributi',
          'Benefits and grants',
        ),
      },
      {
        key: 'income.rent_received',
        name: n(
          'Rendas recebidas',
          'Alquileres cobrados',
          'Loyers perçus',
          'Affitti incassati',
          'Rent received',
        ),
      },
      {
        key: 'income.interest_dividends',
        name: n(
          'Juros e dividendos',
          'Intereses y dividendos',
          'Intérêts et dividendes',
          'Interessi e dividendi',
          'Interest and dividends',
        ),
      },
      {
        key: 'income.refunds',
        name: n('Reembolsos', 'Reembolsos', 'Remboursements', 'Rimborsi', 'Refunds'),
      },
      {
        key: 'income.other',
        name: n(
          'Outras receitas',
          'Otros ingresos',
          'Autres revenus',
          'Altre entrate',
          'Other income',
        ),
      },
    ],
  },
  {
    key: 'housing',
    kind: 'expense',
    name: n('Habitação', 'Vivienda', 'Logement', 'Casa', 'Housing'),
    categories: [
      {
        key: 'housing.mortgage_rent',
        name: n(
          'Prestação/renda',
          'Hipoteca/alquiler',
          'Prêt immobilier/loyer',
          'Mutuo/affitto',
          'Mortgage/rent',
        ),
      },
      {
        key: 'housing.community_fees',
        name: n(
          'Condomínio',
          'Comunidad de vecinos',
          'Charges de copropriété',
          'Spese condominiali',
          'Building fees',
        ),
      },
      {
        key: 'housing.utilities',
        name: n(
          'Água, luz e gás',
          'Agua, luz y gas',
          'Eau, électricité et gaz',
          'Acqua, luce e gas',
          'Water, electricity and gas',
        ),
      },
      {
        key: 'housing.communications',
        name: n(
          'Comunicações',
          'Teléfono e internet',
          'Téléphone et internet',
          'Telefono e internet',
          'Phone and internet',
        ),
      },
      {
        key: 'housing.insurance',
        name: n(
          'Seguros da casa',
          'Seguro del hogar',
          'Assurance habitation',
          'Assicurazione casa',
          'Home insurance',
        ),
      },
      {
        key: 'housing.maintenance',
        name: n('Manutenção', 'Mantenimiento', 'Entretien', 'Manutenzione', 'Maintenance'),
      },
    ],
  },
  {
    key: 'food',
    kind: 'expense',
    name: n('Alimentação', 'Alimentación', 'Alimentation', 'Alimentazione', 'Food'),
    categories: [
      {
        key: 'food.groceries',
        name: n('Supermercado', 'Supermercado', 'Courses', 'Spesa', 'Groceries'),
      },
      {
        key: 'food.restaurants',
        name: n(
          'Restaurantes e cafés',
          'Restaurantes y cafeterías',
          'Restaurants et cafés',
          'Ristoranti e bar',
          'Restaurants and cafes',
        ),
      },
      {
        key: 'food.work_lunch',
        name: n(
          'Almoço de trabalho',
          'Comida de trabajo',
          'Déjeuner au travail',
          'Pranzo di lavoro',
          'Work lunch',
        ),
      },
    ],
  },
  {
    key: 'transport',
    kind: 'expense',
    name: n('Transportes', 'Transporte', 'Transports', 'Trasporti', 'Transport'),
    categories: [
      {
        key: 'transport.fuel',
        name: n('Combustível', 'Combustible', 'Carburant', 'Carburante', 'Fuel'),
      },
      { key: 'transport.tolls', name: n('Portagens', 'Peajes', 'Péages', 'Pedaggi', 'Tolls') },
      {
        key: 'transport.parking',
        name: n('Estacionamento', 'Aparcamiento', 'Stationnement', 'Parcheggio', 'Parking'),
      },
      {
        key: 'transport.public',
        name: n(
          'Transportes públicos',
          'Transporte público',
          'Transports en commun',
          'Trasporto pubblico',
          'Public transport',
        ),
      },
      {
        key: 'transport.car_maintenance',
        name: n(
          'Manutenção automóvel',
          'Mantenimiento del coche',
          'Entretien de la voiture',
          'Manutenzione auto',
          'Car maintenance',
        ),
      },
      {
        key: 'transport.car_insurance',
        name: n(
          'Seguro automóvel',
          'Seguro del coche',
          'Assurance auto',
          'Assicurazione auto',
          'Car insurance',
        ),
      },
    ],
  },
  {
    key: 'kids',
    kind: 'expense',
    name: n('Filhos', 'Hijos', 'Enfants', 'Figli', 'Children'),
    categories: [
      { key: 'kids.school', name: n('Escola', 'Colegio', 'École', 'Scuola', 'School') },
      {
        key: 'kids.activities',
        name: n('Atividades', 'Actividades', 'Activités', 'Attività', 'Activities'),
      },
      {
        key: 'kids.allowance',
        name: n('Mesada', 'Paga', 'Argent de poche', 'Paghetta', 'Allowance'),
      },
      {
        key: 'kids.clothing',
        name: n(
          'Roupa e calçado',
          'Ropa y calzado',
          'Vêtements et chaussures',
          'Abbigliamento e calzature',
          'Clothing and shoes',
        ),
      },
      {
        key: 'kids.health',
        name: n(
          'Saúde dos filhos',
          'Salud de los hijos',
          'Santé des enfants',
          'Salute dei figli',
          "Children's health",
        ),
      },
    ],
  },
  {
    key: 'personal',
    kind: 'expense',
    name: n('Pessoal', 'Personal', 'Personnel', 'Personale', 'Personal'),
    categories: [
      { key: 'personal.health', name: n('Saúde', 'Salud', 'Santé', 'Salute', 'Health') },
      {
        key: 'personal.clothing',
        name: n(
          'Roupa e calçado',
          'Ropa y calzado',
          'Vêtements et chaussures',
          'Abbigliamento e calzature',
          'Clothing and shoes',
        ),
      },
      {
        key: 'personal.care',
        name: n(
          'Cuidados pessoais',
          'Cuidado personal',
          'Soins personnels',
          'Cura della persona',
          'Personal care',
        ),
      },
      { key: 'personal.sports', name: n('Desporto', 'Deporte', 'Sport', 'Sport', 'Sports') },
      {
        key: 'personal.education',
        name: n('Formação', 'Formación', 'Formation', 'Formazione', 'Education and training'),
      },
    ],
  },
  {
    key: 'obligations',
    kind: 'expense',
    name: n('Obrigações', 'Obligaciones', 'Obligations', 'Obblighi', 'Obligations'),
    categories: [
      { key: 'obligations.taxes', name: n('Impostos', 'Impuestos', 'Impôts', 'Imposte', 'Taxes') },
      {
        key: 'obligations.social_security',
        name: n(
          'Segurança Social',
          'Seguridad Social',
          'Sécurité sociale',
          'Previdenza sociale',
          'Social security',
        ),
      },
      {
        key: 'obligations.debt',
        name: n(
          'Dívidas e créditos',
          'Deudas y préstamos',
          'Dettes et crédits',
          'Debiti e prestiti',
          'Debts and loans',
        ),
      },
      {
        key: 'obligations.bank_fees',
        name: n(
          'Comissões bancárias',
          'Comisiones bancarias',
          'Frais bancaires',
          'Commissioni bancarie',
          'Bank fees',
        ),
      },
    ],
  },
  {
    key: 'leisure',
    kind: 'expense',
    name: n(
      'Lazer e outros',
      'Ocio y otros',
      'Loisirs et divers',
      'Svago e altro',
      'Leisure and other',
    ),
    categories: [
      {
        key: 'leisure.subscriptions',
        name: n('Subscrições', 'Suscripciones', 'Abonnements', 'Abbonamenti', 'Subscriptions'),
      },
      { key: 'leisure.travel', name: n('Viagens', 'Viajes', 'Voyages', 'Viaggi', 'Travel') },
      {
        key: 'leisure.leisure',
        name: n('Lazer', 'Ocio', 'Loisirs', 'Tempo libero', 'Entertainment'),
      },
      { key: 'leisure.gifts', name: n('Prendas', 'Regalos', 'Cadeaux', 'Regali', 'Gifts') },
      {
        key: 'leisure.online_shopping',
        name: n(
          'Compras online',
          'Compras online',
          'Achats en ligne',
          'Acquisti online',
          'Online shopping',
        ),
      },
      { key: 'leisure.extras', name: n('Extras', 'Extras', 'Extras', 'Extra', 'Extras') },
      { key: 'leisure.other', name: n('Outros', 'Otros', 'Autres', 'Altro', 'Other') },
    ],
  },
  {
    key: 'savings',
    kind: 'saving',
    name: n('Poupança', 'Ahorro', 'Épargne', 'Risparmio', 'Savings'),
    categories: [
      {
        key: 'savings.emergency_fund',
        name: n(
          'Fundo de emergência',
          'Fondo de emergencia',
          'Fonds d’urgence',
          'Fondo di emergenza',
          'Emergency fund',
        ),
      },
      {
        key: 'savings.investments',
        name: n('Investimentos', 'Inversiones', 'Investissements', 'Investimenti', 'Investments'),
      },
      {
        key: 'savings.goals',
        name: n('Objetivos', 'Objetivos', 'Objectifs', 'Obiettivi', 'Goals'),
      },
    ],
  },
  {
    key: 'transfer',
    kind: 'transfer',
    name: n('Transferências', 'Transferencias', 'Virements', 'Trasferimenti', 'Transfers'),
    categories: [
      {
        key: TRANSFER_CATEGORY_KEY,
        name: n('Entre contas', 'Entre cuentas', 'Entre comptes', 'Tra conti', 'Between accounts'),
      },
    ],
  },
];

export interface SeedResult {
  groupsCreated: number;
  categoriesCreated: number;
}

/**
 * Inserts the template groups/categories the household does not have yet (matched by
 * `template_key`, so renamed, archived or moved rows are never re-added). A transaction-scoped
 * advisory lock serialises concurrent seeders, since `template_key` has no unique constraint.
 */
export async function seedTemplatesInTx(
  tx: Tx,
  householdId: string,
  locale: TemplateLocale,
): Promise<SeedResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`category-templates:${householdId}`}, 0))`,
  );
  const groupRows = await tx
    .select({ id: categoryGroup.id, templateKey: categoryGroup.templateKey })
    .from(categoryGroup)
    .where(and(eq(categoryGroup.householdId, householdId), isNotNull(categoryGroup.templateKey)));
  const categoryRows = await tx
    .select({ templateKey: category.templateKey })
    .from(category)
    .where(and(eq(category.householdId, householdId), isNotNull(category.templateKey)));
  const groupIds = new Map(groupRows.map((g) => [g.templateKey!, g.id]));
  const haveCategory = new Set(categoryRows.map((c) => c.templateKey!));

  const result: SeedResult = { groupsCreated: 0, categoriesCreated: 0 };
  for (const [groupIndex, group] of CATEGORY_TEMPLATES.entries()) {
    let groupId = groupIds.get(group.key);
    if (!groupId) {
      const [row] = await tx
        .insert(categoryGroup)
        .values({
          householdId,
          name: group.name[locale],
          kind: group.kind,
          sort: groupIndex,
          templateKey: group.key,
        })
        .returning({ id: categoryGroup.id });
      groupId = row!.id;
      result.groupsCreated += 1;
    }
    const missing = group.categories
      .map((c, index) => ({ c, index }))
      .filter(({ c }) => !haveCategory.has(c.key));
    if (missing.length === 0) continue;
    await tx.insert(category).values(
      missing.map(({ c, index }) => ({
        householdId,
        groupId: groupId!,
        name: c.name[locale],
        sort: index,
        templateKey: c.key,
      })),
    );
    result.categoriesCreated += missing.length;
  }
  return result;
}

/** Idempotent: safe to call on household creation and again from the backfill. */
export async function seedCategoryTemplates(
  ctx: ServiceCtx,
  locale: TemplateLocale,
): Promise<SeedResult> {
  assertCanWrite(ctx);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    seedTemplatesInTx(tx, ctx.householdId, locale),
  );
}

/**
 * Self-healing seeding for writers: when the household has no template group at all (it was
 * created before the templates existed, or the worker has not run yet) seeds the defaults in the
 * household's locale. One cheap EXISTS in the common case; concurrent callers are serialised by
 * the advisory lock in seedTemplatesInTx and match rows by template key, so it never duplicates.
 * Viewers are read-only and skipped. Returns whether anything was seeded.
 */
export async function ensureHouseholdDefaults(ctx: ServiceCtx): Promise<boolean> {
  if (ctx.role === 'viewer') return false;
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [existing] = await tx
      .select({ id: categoryGroup.id })
      .from(categoryGroup)
      .where(
        and(eq(categoryGroup.householdId, ctx.householdId), isNotNull(categoryGroup.templateKey)),
      )
      .limit(1);
    if (existing) return false;
    const [settings] = await tx
      .select({ locale: householdSettings.locale })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, ctx.householdId));
    const seeded = await seedTemplatesInTx(
      tx,
      ctx.householdId,
      resolveTemplateLocale(settings?.locale ?? 'en'),
    );
    return seeded.groupsCreated > 0 || seeded.categoriesCreated > 0;
  });
}

/**
 * Seeds the templates (in the household's locale) for every household that has none yet.
 * Idempotent and cheap to repeat, so the worker runs it at startup. Households that already have
 * any template row are skipped, so categories a user deleted or archived are never resurrected.
 * Returns the number of households seeded.
 */
export async function backfillHouseholdDefaults(db: Db): Promise<number> {
  const households = await db.select({ id: organization.id }).from(organization);
  let seeded = 0;
  for (const { id } of households) {
    const created = await withHousehold(db, id, async (tx) => {
      const [existing] = await tx
        .select({ id: categoryGroup.id })
        .from(categoryGroup)
        .where(and(eq(categoryGroup.householdId, id), isNotNull(categoryGroup.templateKey)))
        .limit(1);
      if (existing) return false;
      const [settings] = await tx
        .select({ locale: householdSettings.locale })
        .from(householdSettings)
        .where(eq(householdSettings.householdId, id));
      await seedTemplatesInTx(tx, id, resolveTemplateLocale(settings?.locale ?? 'en'));
      return true;
    });
    if (created) seeded += 1;
  }
  return seeded;
}
