'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { parsePlanned, tidyPlannedInput, toPlannedInput } from '@/lib/amount-input';
import { truncateName } from '@/lib/budget-import-copy';
import { monthlyAverage } from '@/lib/budget-grid';
import { cn } from '@/lib/cn';
import { addMonths, formatMonthShort } from '@/lib/dates';
import { sharedAccountWarning } from '@/lib/saving-line-warnings';
import { deleteBudgetLineAction, saveBudgetLineAction } from '@/server/actions/budget';
import type { BudgetDto, BucketOption } from '@/server/budget-data';
import type { Lookups } from '@/server/lookups';
import { CategoryChip } from '../category-icon';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useLeaveGuard } from '../use-leave-guard';
import { CategoryMultiPicker } from './category-multi-picker';
import { BucketsPicker } from './buckets-picker';
import { useFormatMoney } from '@/components/privacy';

export type LineKind = 'income' | 'expense' | 'saving';
const KINDS: readonly LineKind[] = ['expense', 'income', 'saving'];
const NAME_MAX = 80;

export interface LineFormValues {
  name: string;
  kind: LineKind;
  groupId: string;
  accountId: string;
  categoryIds: string[];
  bucketIds: string[];
  /** The twelve amounts as typed ("120,50"); empty is zero. */
  amounts: string[];
  notes: string;
}

export interface EditableLine {
  id: string;
  name: string;
  kind: LineKind;
  groupId: string | null;
  accountId: string | null;
  categoryIds: string[];
  bucketIds: string[];
  amounts: number[];
  notes: string | null;
}

/** Add or change one budget line: what it is, what it counts and what it plans for each month. */
export function LineEditor({
  budget,
  line,
  defaultKind,
  others,
  bucketsByAccount,
  lookups,
  hubAccountId,
  back,
}: {
  budget: BudgetDto;
  line: EditableLine | null;
  defaultKind: LineKind;
  /** The other lines of this budget, to tell which categories they already count. */
  others: Array<{
    id: string;
    name: string;
    kind: LineKind;
    accountId: string | null;
    categoryIds: string[];
    bucketIds: string[];
  }>;
  /** Pies of each investment account, by account id. */
  bucketsByAccount: Record<string, BucketOption[]>;
  lookups: Lookups;
  /** The household's main account, if one is set. */
  hubAccountId: string | null;
  back: string;
}) {
  const t = useTranslations('budgetLine');
  const common = useTranslations('common');
  const kinds = useTranslations('budget.kinds');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const symbol =
    new Intl.NumberFormat(locale, { style: 'currency', currency })
      .formatToParts(0)
      .find((p) => p.type === 'currency')?.value ?? currency;

  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        formatMonthShort(addMonths(budget.startMonth, i), locale, true),
      ),
    [budget.startMonth, locale],
  );

  const initial: LineFormValues = useMemo(
    () => ({
      name: line?.name ?? '',
      kind: line?.kind ?? defaultKind,
      groupId: line?.groupId ?? '',
      accountId: line?.accountId ?? '',
      categoryIds: line?.categoryIds ?? [],
      bucketIds: line?.bucketIds ?? [],
      amounts: (line?.amounts ?? Array.from({ length: 12 }, () => 0)).map((a) =>
        toPlannedInput(a, locale),
      ),
      notes: line?.notes ?? '',
    }),
    [line, defaultKind, locale],
  );
  const [values, setValues] = useState<LineFormValues>(initial);
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [kindHint, setKindHint] = useState(false);
  const [same, setSame] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [pending, startTransition] = useTransition();
  const [deleting, startDelete] = useTransition();

  const dirty = !saved && JSON.stringify(values) !== JSON.stringify(initial);
  const { dialog: leaveDialog, leave } = useLeaveGuard(dirty);

  const set = <K extends keyof LineFormValues>(key: K, value: LineFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const groupsOfKind = lookups.groups.filter((g) => !g.archived && g.kind === values.kind);
  // A stored group of another kind (the kind was changed) stays selectable until it is replaced.
  const accounts = lookups.accounts.filter((a) => !a.archived || a.id === values.accountId);
  const categoryById = useMemo(() => new Map(lookups.categories.map((c) => [c.id, c])), [lookups]);
  const takenBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of others) for (const id of o.categoryIds) map.set(id, o.name);
    return map;
  }, [others]);

  const bucketTakenBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of others) for (const id of o.bucketIds) map.set(id, o.name);
    return map;
  }, [others]);
  const bucketOptions =
    values.kind === 'saving' && values.accountId !== ''
      ? bucketsByAccount[values.accountId]
      : undefined;
  const shared =
    values.kind === 'saving'
      ? sharedAccountWarning(
          values.accountId,
          values.bucketIds,
          others,
          bucketOptions !== undefined,
        )
      : null;
  // The picker is hidden for an archived investment account: renaming the line must not drop
  // the pies it already counts, so they are resent while the account is unchanged.
  const keptBucketIds =
    line &&
    line.kind === 'saving' &&
    values.kind === 'saving' &&
    values.accountId === (line.accountId ?? '')
      ? line.bucketIds
      : [];

  const parsed = values.amounts.map(parsePlanned);
  const minors = parsed.map((p) => (p.ok ? p.minor : 0));
  const total = minors.reduce((a, b) => a + b, 0);

  function changeKind(next: LineKind) {
    if (next === values.kind) return;
    setValues((v) => {
      const groupStillFits = lookups.groups.some((g) => g.id === v.groupId && g.kind === next);
      return { ...v, kind: next, groupId: groupStillFits ? v.groupId : '' };
    });
    setKindHint(values.categoryIds.length > 0);
  }

  // --- amount helpers: they only edit the form; nothing is saved until "Guardar".
  function applySame() {
    const value = parsePlanned(same ?? '');
    if (!value.ok) {
      setErrors((e) => ({ ...e, same: t(`amount.${value.reason}`) }));
      return;
    }
    setErrors((e) => ({ ...e, same: '' }));
    const before = values.amounts;
    const text = toPlannedInput(value.minor, locale);
    const hadOther = minors.some((m) => m !== 0 && m !== value.minor);
    set(
      'amounts',
      Array.from({ length: 12 }, () => text),
    );
    setSame(null);
    if (hadOther) {
      toast.success(t('helpers.sameApplied'), {
        label: t('helpers.undo'),
        onClick: () => set('amounts', before),
      });
    }
  }

  const fillPlan = useMemo(() => {
    const next = [...values.amounts];
    let carry: string | null = null;
    let filled = 0;
    let hasValue = false;
    let setCount = 0;
    for (let i = 0; i < 12; i++) {
      const p = parsePlanned(values.amounts[i]!);
      if (p.ok && p.minor !== 0) {
        carry = values.amounts[i]!;
        hasValue = true;
        setCount += 1;
      } else if (p.ok && carry !== null) {
        next[i] = carry;
        filled += 1;
      }
    }
    return { next, filled, hasValue, allSet: setCount === 12 };
  }, [values.amounts]);

  function copyForward() {
    if (fillPlan.filled === 0) return;
    const before = values.amounts;
    set('amounts', fillPlan.next);
    toast.success(t('helpers.copied', { count: fillPlan.filled }), {
      label: t('helpers.undo'),
      onClick: () => set('amounts', before),
    });
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!values.name.trim()) found.name = t('nameRequired');
    parsed.forEach((p, i) => {
      if (!p.ok) found[`amount-${i}`] = t(`amount.${p.reason}`);
    });
    return found;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    startTransition(async () => {
      const result = await saveBudgetLineAction(budget.id, {
        line: {
          ...(line ? { id: line.id } : {}),
          kind: values.kind,
          name: values.name.trim(),
          groupId: values.groupId || null,
          accountId: values.accountId || null,
          notes: values.notes.trim() || null,
        },
        amounts: minors,
        categoryIds: values.categoryIds,
        // Hidden picker: keep the stored pies only while kind and account are unchanged.
        bucketIds: bucketOptions ? values.bucketIds : keptBucketIds,
      });
      if (!result.ok) {
        if (result.code === 'validation' && result.detail?.code === 'line_name_taken') {
          setErrors({ name: t('nameTaken') });
          return;
        }
        if (result.code === 'validation' && result.detail?.code === 'transfer_category') {
          setFormError(t('transferCategory'));
          return;
        }
        if (
          result.code === 'validation' &&
          result.detail?.code === 'buckets_need_investment_account'
        ) {
          setFormError(t('bucketsNeedInvestment'));
          return;
        }
        if (result.code === 'conflict' && result.conflict === 'bucket_already_linked') {
          setFormError(t('bucketConflict'));
          router.refresh();
          return;
        }
        if (result.code === 'conflict' && result.conflict === 'category_already_linked') {
          setFormError(t('conflict'));
          router.refresh();
          return;
        }
        setFormError(failure(result));
        return;
      }
      setSaved(true);
      toast.success(t('saved'));
      const url = back.split('#')[0]!;
      router.push(`${url}#line-${result.data.id}`);
    });
  }

  function remove() {
    if (!line) return;
    startDelete(async () => {
      const result = await deleteBudgetLineAction(line.id);
      if (!result.ok) {
        setFormError(failure(result));
        return;
      }
      setSaved(true);
      toast.success(t('deleted'));
      router.push(back.split('#')[0]!);
    });
  }

  const messages = Object.entries(errors).filter(([, v]) => v);
  const fieldLabel = (key: string): string =>
    key === 'name'
      ? t('name')
      : key === 'same'
        ? t('helpers.same')
        : (months[Number(key.split('-')[1])] ?? key);
  function focusField(key: string) {
    const el =
      key === 'name'
        ? document.querySelector<HTMLElement>('[name="name"]')
        : document.querySelector<HTMLElement>(`[name="${key}"]`);
    el?.focus();
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 md:gap-5">
      {leaveDialog}
      {submitted && messages.length > 0 ? (
        <Alert tone="error" title={t('summary', { count: messages.length })}>
          <ul className="grid grid-cols-1 gap-1">
            {messages.map(([key, message]) => (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => focusField(key)}
                  className="min-h-11 text-left underline underline-offset-4"
                >
                  {fieldLabel(key)}: {message}
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <Card className="grid grid-cols-1 gap-5">
        <Field label={t('name')} error={errors.name}>
          {(p) => (
            <Input
              {...p}
              name="name"
              value={values.name}
              maxLength={NAME_MAX}
              required
              autoComplete="off"
              onChange={(e) => {
                set('name', e.target.value);
                setErrors((cur) => ({ ...cur, name: '' }));
              }}
            />
          )}
        </Field>

        <fieldset className="grid grid-cols-1 gap-1.5">
          <legend className="text-sm font-medium">{t('kind')}</legend>
          <div className="inline-flex w-fit rounded-lg bg-surface-2 p-1">
            {KINDS.map((value) => (
              <label
                key={value}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center rounded-md px-4 text-sm font-medium transition-colors duration-[120ms] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring md:min-h-9',
                  values.kind === value
                    ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <input
                  type="radio"
                  name="kind"
                  value={value}
                  checked={values.kind === value}
                  onChange={() => changeKind(value)}
                  className="sr-only"
                />
                {kinds(value)}
              </label>
            ))}
          </div>
          {kindHint ? <p className="text-sm text-muted-foreground">{t('kindHint')}</p> : null}
        </fieldset>

        <Field
          label={t('group')}
          hint={
            <>
              {t('groupHint')}{' '}
              <Link
                href="/settings/categories"
                className="text-primary underline underline-offset-4"
              >
                {t('groupLink')}
              </Link>
            </>
          }
        >
          {(p) => (
            <Select
              {...p}
              name="groupId"
              value={values.groupId}
              onChange={(e) => set('groupId', e.target.value)}
            >
              <option value="">{t('noGroup')}</option>
              {groupsOfKind.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-1.5">
          <Field label={t('account')} hint={t(`accountHint.${values.kind}`)}>
            {(p) => (
              <Select
                {...p}
                name="accountId"
                value={values.accountId}
                onChange={(e) =>
                  // Pies belong to one account: another account starts with none ticked.
                  setValues((v) => ({ ...v, accountId: e.target.value, bucketIds: [] }))
                }
              >
                <option value="">{t('noAccount')}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {values.kind === 'saving' && values.accountId === '' ? (
            <p className="text-sm font-medium text-warning">{t('savingNoAccount')}</p>
          ) : null}
          {values.kind === 'saving' &&
          hubAccountId !== null &&
          values.accountId === hubAccountId ? (
            <p className="text-sm text-muted-foreground">{t('savingOnHub')}</p>
          ) : null}
          {bucketOptions ? (
            <BucketsPicker
              key={values.accountId}
              options={bucketOptions}
              selected={values.bucketIds}
              takenBy={bucketTakenBy}
              onChange={(bucketIds) => set('bucketIds', bucketIds)}
            />
          ) : null}
          <div role="status">
            {shared !== null ? (
              <p className="text-sm font-medium text-warning">
                {t(shared.key, { line: truncateName(shared.line) })}
              </p>
            ) : null}
          </div>
        </div>
      </Card>

      <Card as="section" aria-labelledby="line-categories-title" className="grid grid-cols-1 gap-3">
        <h2 id="line-categories-title" className="text-card-title">
          {t('categories')}
        </h2>
        {values.categoryIds.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {values.categoryIds.map((id) => {
              const category = categoryById.get(id);
              return (
                <li key={id} className="max-w-full">
                  <CategoryChip
                    category={category}
                    uncategorisedLabel={common('uncategorised')}
                    large
                    trailing={
                      <button
                        type="button"
                        aria-label={t('removeCategory', { name: category?.name ?? '' })}
                        onClick={() =>
                          set(
                            'categoryIds',
                            values.categoryIds.filter((c) => c !== id),
                          )
                        }
                        className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-3 hover:text-foreground"
                      >
                        <X className="size-4" aria-hidden="true" />
                      </button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
        )}
        <Button variant="outline" className="justify-self-start" onClick={() => setPicking(true)}>
          {t('chooseCategories')}
        </Button>
      </Card>

      <Card className="grid grid-cols-1 gap-5">
        <fieldset className="grid grid-cols-1 gap-3">
          <legend className="mb-1 text-card-title">{t('planned')}</legend>
          <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
            {same === null ? (
              <Button variant="link" onClick={() => setSame('')}>
                {t('helpers.same')}
              </Button>
            ) : (
              <div className="flex w-full flex-wrap items-end gap-2">
                <Field label={t('helpers.same')} error={errors.same} className="w-44">
                  {(p) => (
                    <Input
                      {...p}
                      name="same"
                      inputMode="decimal"
                      autoComplete="off"
                      autoFocus
                      value={same}
                      className="text-right tabular-nums"
                      onChange={(e) => setSame(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          applySame();
                        }
                      }}
                    />
                  )}
                </Field>
                <Button variant="outline" onClick={applySame}>
                  {common('apply')}
                </Button>
                <Button variant="ghost" onClick={() => setSame(null)}>
                  {common('cancel')}
                </Button>
              </div>
            )}
            <div className="grid grid-cols-1 justify-items-start">
              <Button
                variant="link"
                aria-disabled={fillPlan.filled === 0 || undefined}
                aria-describedby={fillPlan.filled === 0 ? 'copy-forward-reason' : undefined}
                className={cn(
                  fillPlan.filled === 0 && 'cursor-not-allowed opacity-60 hover:no-underline',
                )}
                onClick={copyForward}
              >
                {t('helpers.copy')}
              </Button>
              {fillPlan.filled === 0 ? (
                <span id="copy-forward-reason" className="px-1 text-sm text-muted-foreground">
                  {!fillPlan.hasValue
                    ? t('helpers.copyNeedsValue')
                    : fillPlan.allSet
                      ? t('helpers.copyNothing')
                      : t('helpers.copyNoGaps')}
                </span>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
            {months.map((label, i) => (
              <Field key={i} label={label} error={errors[`amount-${i}`]}>
                {(p) => (
                  <div className="relative">
                    <Input
                      {...p}
                      name={`amount-${i}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={values.amounts[i]}
                      placeholder="0"
                      className="pr-8 text-right tabular-nums"
                      onBlur={() => {
                        // Tidy a valid amount into the locale's typing form ("3000,50").
                        const tidy = tidyPlannedInput(values.amounts[i]!, locale);
                        if (tidy === null || tidy === values.amounts[i]) return;
                        const next = [...values.amounts];
                        next[i] = tidy;
                        set('amounts', next);
                      }}
                      onChange={(e) => {
                        const next = [...values.amounts];
                        next[i] = e.target.value;
                        set('amounts', next);
                        setErrors((cur) => ({ ...cur, [`amount-${i}`]: '' }));
                      }}
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
                    >
                      {symbol}
                    </span>
                  </div>
                )}
              </Field>
            ))}
          </div>
          <p className="text-sm tabular-nums text-muted-foreground" aria-live="polite">
            {t('totals', { total: money(total), average: money(monthlyAverage(total, 12)) })}
          </p>
        </fieldset>

        <Field label={t('notes')}>
          {(p) => (
            <Textarea
              {...p}
              name="notes"
              rows={3}
              maxLength={2000}
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>
      </Card>

      <div
        className={cn(
          'sticky bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom))] z-20 -mx-4 flex items-center justify-between gap-3 border-t bg-background px-4 py-3 md:static md:mx-0 md:border-0 md:px-0 md:py-0',
          !dirty && 'max-md:static max-md:border-0 max-md:bg-transparent max-md:px-4 max-md:py-0',
        )}
      >
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {dirty ? t('dirty') : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => leave(back.split('#')[0]!)}>
            {common('cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {pending ? common('saving') : common('save')}
          </Button>
        </div>
      </div>

      {line ? (
        <div className="grid grid-cols-1 gap-2 border-t pt-5">
          <ConfirmDialog
            trigger={
              <Button
                variant="outline"
                className="justify-self-start border-negative text-negative hover:bg-negative-soft"
              >
                {t('delete')}
              </Button>
            }
            title={t('deleteTitle', { name: truncateName(line.name) })}
            description={t('deleteBody')}
            confirmLabel={t('deleteConfirm')}
            cancelLabel={common('cancel')}
            onConfirm={remove}
            pending={deleting}
          />
        </div>
      ) : null}

      <CategoryMultiPicker
        open={picking}
        onOpenChange={setPicking}
        groups={lookups.groups}
        kind={values.kind}
        selected={values.categoryIds}
        takenBy={takenBy}
        onConfirm={(ids) => set('categoryIds', ids)}
      />
    </form>
  );
}
