import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Tx } from '@arfolio/db';
import { CATEGORY_TEMPLATES, resolveTemplateLocale } from '../category-templates.js';

const { category, categoryGroup, householdSettings } = schema;

export type FallbackKind = 'expense' | 'income';

const FALLBACK = {
  expense: {
    groupKey: 'leisure',
    key: 'leisure.other',
    names: ['outros', 'other'],
  },
  income: {
    groupKey: 'income',
    key: 'income.other',
    names: ['outras receitas', 'other income', 'outros', 'other'],
  },
} as const;

/** Lower case with diacritics folded, so "Óutros" matches "outros". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

async function openCategories(tx: Tx, householdId: string, kind: FallbackKind) {
  return tx
    .select({ id: category.id, name: category.name, templateKey: category.templateKey })
    .from(category)
    .innerJoin(
      categoryGroup,
      and(
        eq(category.groupId, categoryGroup.id),
        eq(category.householdId, categoryGroup.householdId),
      ),
    )
    .where(
      and(
        eq(category.householdId, householdId),
        eq(categoryGroup.kind, kind),
        isNull(category.archivedAt),
        isNull(categoryGroup.archivedAt),
      ),
    )
    .orderBy(asc(category.createdAt), asc(category.id));
}

/** An archived template category in an open group is brought back rather than duplicated. */
async function revive(tx: Tx, householdId: string, kind: FallbackKind): Promise<string | null> {
  const [row] = await tx
    .select({ id: category.id })
    .from(category)
    .innerJoin(
      categoryGroup,
      and(
        eq(category.groupId, categoryGroup.id),
        eq(category.householdId, categoryGroup.householdId),
      ),
    )
    .where(
      and(
        eq(category.householdId, householdId),
        eq(category.templateKey, FALLBACK[kind].key),
        eq(categoryGroup.kind, kind),
        isNull(categoryGroup.archivedAt),
        isNotNull(category.archivedAt),
      ),
    )
    .orderBy(asc(category.createdAt), asc(category.id))
    .limit(1);
  if (!row) return null;
  await tx.update(category).set({ archivedAt: null }).where(eq(category.id, row.id));
  return row.id;
}

async function find(tx: Tx, householdId: string, kind: FallbackKind): Promise<string | null> {
  const wanted = FALLBACK[kind];
  const rows = await openCategories(tx, householdId, kind);
  const byKey = rows.find((r) => r.templateKey === wanted.key);
  if (byKey) return byKey.id;
  for (const name of wanted.names) {
    const byName = rows.find((r) => fold(r.name) === name);
    if (byName) return byName.id;
  }
  return null;
}

/**
 * The category a row falls back to when the model could not categorise it: "Outros" for money
 * spent, "Outras receitas" for money received. Found by template key, else by name, else created
 * from the template (an archived one in an open group is un-archived instead; in its template group, which is created too when the household has none).
 * Must run inside `withHousehold` for the household.
 */
export async function resolveFallbackCategory(
  tx: Tx,
  householdId: string,
  kind: FallbackKind,
): Promise<string> {
  const existing = await find(tx, householdId, kind);
  if (existing) return existing;

  // Same lock as the template seeder, since `template_key` has no unique constraint.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`category-templates:${householdId}`}, 0))`,
  );
  const raced = (await find(tx, householdId, kind)) ?? (await revive(tx, householdId, kind));
  if (raced) return raced;

  const wanted = FALLBACK[kind];
  const [settings] = await tx
    .select({ locale: householdSettings.locale })
    .from(householdSettings)
    .where(eq(householdSettings.householdId, householdId));
  const locale = resolveTemplateLocale(settings?.locale ?? 'en');
  const groupIndex = CATEGORY_TEMPLATES.findIndex((g) => g.key === wanted.groupKey);
  const template = CATEGORY_TEMPLATES[groupIndex]!;
  const templateCategory = template.categories.find((c) => c.key === wanted.key)!;

  const [byKey] = await tx
    .select({ id: categoryGroup.id, archivedAt: categoryGroup.archivedAt })
    .from(categoryGroup)
    .where(
      and(
        eq(categoryGroup.householdId, householdId),
        eq(categoryGroup.templateKey, wanted.groupKey),
      ),
    );
  let groupId = byKey && !byKey.archivedAt ? byKey.id : null;
  if (!groupId && byKey) {
    // The household archived the template group: use its first open group of the same kind.
    const [open] = await tx
      .select({ id: categoryGroup.id })
      .from(categoryGroup)
      .where(
        and(
          eq(categoryGroup.householdId, householdId),
          eq(categoryGroup.kind, kind),
          isNull(categoryGroup.archivedAt),
          ne(categoryGroup.id, byKey.id),
        ),
      )
      .orderBy(asc(categoryGroup.sort), asc(categoryGroup.name), asc(categoryGroup.id))
      .limit(1);
    groupId = open?.id ?? null;
  }
  if (!groupId) {
    const [created] = await tx
      .insert(categoryGroup)
      .values({
        householdId,
        name: template.name[locale],
        kind: template.kind,
        sort: groupIndex,
        templateKey: wanted.groupKey,
      })
      .returning({ id: categoryGroup.id });
    groupId = created!.id;
  }
  const [last] = await tx
    .select({ sort: sql<number>`coalesce(max(${category.sort}), -1)::int` })
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.groupId, groupId)));
  const [row] = await tx
    .insert(category)
    .values({
      householdId,
      groupId,
      name: templateCategory.name[locale],
      sort: (last?.sort ?? -1) + 1,
      templateKey: wanted.key,
    })
    .returning({ id: category.id });
  return row!.id;
}
