'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { parseAmount, validateWildcardPattern } from '@arfolio/core';
import {
  createRuleAction,
  previewRuleApplicationAction,
  updateRuleAction,
} from '@/server/actions/rules';
import type { AccountDto, CategoryDto, GroupDto, RuleDto } from '@/server/serialize';
import { CategoryChip } from '../category-icon';
import { CategoryPicker } from '../category-picker';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage, useReportFailure } from '../use-action-error';
import { useApplyRule } from './use-apply-rule';

/** How long the saved toast waits for the preview before it falls back to the plain message. */
const OFFER_WAIT_MS = 1500;

/** Key order does not matter: the form and the server may list the same condition differently. */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, val]) => [k, canon(val)]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

function toInput(minor: number | undefined): string {
  if (minor === undefined) return '';
  const abs = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Create or edit a rule: what it matches (every filled field must match) and the category. */
export function RuleFormSheet({
  open,
  onOpenChange,
  rule,
  accounts,
  groups,
  categories,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: RuleDto;
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
  onSaved: () => void;
}) {
  const t = useTranslations('rules');
  const toast = useToast();
  const failure = useFailureMessage();
  const report = useReportFailure();
  const apply = useApplyRule();
  const applyT = useTranslations('rules.apply');
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [contains, setContains] = useState('');
  const [pattern, setPattern] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const c = rule?.condition;
    setName(rule?.name ?? '');
    setContains(c?.descriptionContains ?? '');
    setPattern(c?.descriptionPattern ?? '');
    setCounterparty(c?.counterpartyContains ?? '');
    setDirection(c?.direction ?? '');
    setMin(toInput(c?.amountMin));
    setMax(toInput(c?.amountMax));
    setAccountIds(c?.accountIds ?? []);
    setCategoryId(rule?.categoryId ?? '');
    setError(null);
    setErrors({});
  }, [open, rule]);

  const category = categories.find((c) => c.id === categoryId);

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    const condition: Record<string, unknown> = {};
    if (contains.trim()) condition.descriptionContains = contains.trim();
    if (pattern.trim()) {
      if (!validateWildcardPattern(pattern).ok) found.pattern = t('patternInvalid');
      else condition.descriptionPattern = pattern;
    }
    if (counterparty.trim()) condition.counterpartyContains = counterparty.trim();
    if (direction) condition.direction = direction;
    for (const [key, raw, field] of [
      ['amountMin', min, 'min'],
      ['amountMax', max, 'max'],
    ] as const) {
      if (!raw.trim()) continue;
      try {
        condition[key] = parseAmount(raw);
      } catch {
        found[field] = t('amountInvalid');
      }
    }
    if (accountIds.length > 0) condition.accountIds = accountIds;
    if (!name.trim()) found.name = t('nameRequired');
    if (Object.keys(condition).length === 0 && Object.keys(found).length === 0) {
      found.condition = t('conditionRequired');
    }
    if (!categoryId) found.category = t('categoryRequired');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    startTransition(async () => {
      const body = { name, condition: condition as RuleDto['condition'], categoryId };
      const result = rule ? await updateRuleAction(rule.id, body) : await createRuleAction(body);
      if (!result.ok) return setError(failure(result));
      const saved = result.data;
      const worthOffering =
        saved.enabled &&
        (!rule ||
          !sameJson(rule.condition, saved.condition) ||
          rule.categoryId !== saved.categoryId);
      onOpenChange(false);
      onSaved();
      // The sheet is already closed: the toast follows once the preview is back (or the wait is up).
      void announce(saved, worthOffering);
    });
  }

  /** One toast: with "Aplicar" when the rule would change existing movements, plain otherwise. */
  async function announce(saved: RuleDto, offer: boolean) {
    const plain = () => toast.success(rule ? t('saved') : t('created'));
    if (!offer) return plain();
    let changes = 0;
    try {
      const preview = await Promise.race([
        previewRuleApplicationAction(saved.id),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), OFFER_WAIT_MS)),
      ]);
      if (preview?.ok) changes = preview.data.changes;
    } catch {
      // No preview, no offer: the row menu stays the way to apply it.
    }
    if (changes === 0) return plain();
    const name = categories.find((c) => c.id === saved.categoryId)?.name ?? '';
    toast.success(applyT(rule ? 'offerSaved' : 'offerCreated', { count: changes }), {
      label: applyT('offerAction'),
      onClick: () =>
        void apply(saved.id, name).then((outcome) => {
          if (!outcome.ok) report(outcome);
        }),
    });
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={rule ? t('editTitle') : t('addTitle')}
        tall
      >
        <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Field label={t('name')} error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={120}
                required
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setErrors((cur) => ({ ...cur, name: '' }));
                }}
              />
            )}
          </Field>
          <p className="text-sm text-muted-foreground">{t('conditionsIntro')}</p>
          {errors.condition ? <Alert tone="error">{errors.condition}</Alert> : null}
          <Field label={t('contains')} hint={t('containsHint')}>
            {(p) => (
              <Input
                {...p}
                value={contains}
                maxLength={200}
                onChange={(e) => setContains(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('pattern')} hint={t('patternHint')} error={errors.pattern}>
            {(p) => (
              <Input
                {...p}
                value={pattern}
                maxLength={200}
                onChange={(e) => setPattern(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('counterparty')}>
            {(p) => (
              <Input
                {...p}
                value={counterparty}
                maxLength={200}
                onChange={(e) => setCounterparty(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('direction')}>
            {(p) => (
              <Select
                {...p}
                value={direction}
                onChange={(e) => setDirection(e.target.value as '' | 'in' | 'out')}
              >
                <option value="">{t('directionAny')}</option>
                <option value="out">{t('directionOut')}</option>
                <option value="in">{t('directionIn')}</option>
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('amountMin')} error={errors.min} hint={t('amountHint')}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={min}
                  className="tabular-nums"
                  onChange={(e) => setMin(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('amountMax')} error={errors.max}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={max}
                  className="tabular-nums"
                  onChange={(e) => setMax(e.target.value)}
                />
              )}
            </Field>
          </div>
          {accounts.some((a) => !a.archived) ? (
            <fieldset className="grid grid-cols-1">
              <legend className="mb-1 text-sm font-medium">{t('accounts')}</legend>
              {accounts
                .filter((a) => !a.archived)
                .map((a) => (
                  <Checkbox
                    key={a.id}
                    label={a.name}
                    checked={accountIds.includes(a.id)}
                    onChange={(e) =>
                      setAccountIds((cur) =>
                        e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id),
                      )
                    }
                  />
                ))}
            </fieldset>
          ) : null}
          <div className="grid grid-cols-1 gap-1.5">
            <span className="text-sm font-medium">{t('category')}</span>
            <div>
              <CategoryChip
                category={category}
                uncategorisedLabel={t('categoryChoose')}
                large
                onClick={() => setPickerOpen(true)}
              />
            </div>
            {errors.category ? <p className="text-sm text-negative">{errors.category}</p> : null}
          </div>
          <Button type="submit" loading={pending}>
            {t('save')}
          </Button>
        </form>
      </Sheet>
      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        groups={groups}
        selectedId={categoryId}
        showMerchantOptions={false}
        onPick={(id) => {
          setCategoryId(id);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
