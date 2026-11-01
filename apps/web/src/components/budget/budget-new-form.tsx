'use client';

import { Copy, FileUp, FilePlus2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { monthParam } from '@/lib/budget-period';
import { truncateName } from '@/lib/budget-import-copy';
import { cn } from '@/lib/cn';
import { createBudgetAction } from '@/server/actions/budget';
import type { BudgetDto } from '@/server/budget-data';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Field } from '../ui/field';
import { Select } from '../ui/select';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

type Choice = 'copy' | 'import' | 'empty';

/** Start a budget year empty, as a copy of the one before, or from the spreadsheet. */
export function BudgetNewForm({
  budgets,
  options,
  initialStart,
}: {
  budgets: BudgetDto[];
  /** Start months (`yyyy-mm-01`) offered, with their range label. */
  options: Array<{ start: string; label: string }>;
  initialStart: string;
}) {
  const t = useTranslations('budgetNew');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const existing = useMemo(() => new Map(budgets.map((b) => [b.startMonth, b])), [budgets]);
  const [start, setStart] = useState(initialStart);
  const previous = useMemo(
    () =>
      [...budgets]
        .filter((b) => b.startMonth < start)
        .sort((a, b) => b.startMonth.localeCompare(a.startMonth))[0] ?? null,
    [budgets, start],
  );
  const [picked, setPicked] = useState<Choice | null>(null);
  const choice: Choice =
    picked === 'copy' && !previous ? 'empty' : (picked ?? (previous ? 'copy' : 'empty'));
  const [error, setError] = useState<string | null>(null);
  const [clash, setClash] = useState(false);
  const [pending, startTransition] = useTransition();
  const taken = existing.get(start);

  function submit() {
    setError(null);
    setClash(false);
    if (choice === 'import') {
      router.push('/import/budget');
      return;
    }
    startTransition(async () => {
      const result = await createBudgetAction({
        startMonth: start,
        ...(choice === 'copy' && previous ? { copyFromBudgetId: previous.id } : {}),
      });
      if (!result.ok) {
        const exists =
          (result.code === 'validation' && result.detail?.code === 'budget_exists') ||
          (result.code === 'conflict' && result.conflict === 'budget_exists');
        if (exists) setClash(true);
        else setError(failure(result));
        return;
      }
      toast.success(t('created'));
      router.push(`/budget?month=${monthParam(start)}`);
    });
  }

  const cards: Array<{
    id: Choice;
    title: string;
    body: string;
    Icon: typeof Copy;
    hidden?: boolean;
  }> = [
    {
      id: 'copy',
      title: t('copyTitle', { name: truncateName(previous?.name ?? '') }),
      body: t('copyBody'),
      Icon: Copy,
      hidden: !previous,
    },
    { id: 'import', title: t('importTitle'), body: t('importBody'), Icon: FileUp },
    { id: 'empty', title: t('emptyTitle'), body: t('emptyBody'), Icon: FilePlus2 },
  ];

  return (
    <form
      method="post"
      className="grid grid-cols-1 gap-4 md:gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!taken) submit();
      }}
    >
      {clash ? (
        <Alert
          tone="error"
          action={
            <Link
              href={`/budget?month=${monthParam(start)}`}
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            >
              {t('open')}
            </Link>
          }
        >
          {t('exists')}
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="grid grid-cols-1 gap-5">
        <Field
          label={t('year')}
          hint={
            <>
              {t('yearHint')}{' '}
              <Link href="/settings/budget" className="text-primary underline underline-offset-4">
                {t('yearLink')}
              </Link>
            </>
          }
        >
          {(p) => (
            <Select
              {...p}
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setClash(false);
              }}
            >
              {options.map((o) => (
                <option key={o.start} value={o.start} disabled={existing.has(o.start)}>
                  {o.label}
                  {existing.has(o.start) ? ` ${t('alreadyExists')}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <fieldset className="grid grid-cols-1 gap-2">
          <legend className="mb-1 text-sm font-medium">{t('how')}</legend>
          {cards
            .filter((c) => !c.hidden)
            .map(({ id, title, body, Icon }) => (
              <label
                key={id}
                className={cn(
                  'flex min-h-[72px] cursor-pointer items-center gap-3 rounded-lg p-4 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                  choice === id
                    ? 'bg-primary-soft shadow-[0_0_0_1px_var(--primary-border)]'
                    : 'bg-surface-2 hover:bg-surface-3',
                )}
              >
                <input
                  type="radio"
                  name="how"
                  value={id}
                  checked={choice === id}
                  onChange={() => setPicked(id)}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <Icon className="size-6 shrink-0 text-primary-text" aria-hidden="true" />
                <span className="grid grid-cols-1 min-w-0">
                  <span className="break-words text-base font-medium">{title}</span>
                  <span className="text-sm text-muted-foreground">{body}</span>
                </span>
              </label>
            ))}
        </fieldset>
      </Card>

      <div className="flex items-center gap-3">
        <Button
          type="submit"
          loading={pending}
          aria-disabled={taken ? true : undefined}
          aria-describedby={taken ? 'budget-taken' : undefined}
          className={cn(taken && 'opacity-60')}
        >
          {choice === 'import' ? t('continueImport') : t('create')}
        </Button>
        {taken ? (
          <p id="budget-taken" className="text-sm text-muted-foreground">
            {t('exists')}
          </p>
        ) : null}
      </div>
    </form>
  );
}
