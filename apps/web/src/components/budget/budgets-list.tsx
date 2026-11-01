'use client';

import { Archive, ArchiveRestore, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { truncateName } from '@/lib/budget-import-copy';
import { formatBudgetRange, monthParam } from '@/lib/budget-period';
import { renameBudgetAction, setBudgetArchivedAction } from '@/server/actions/budget';
import type { BudgetDto } from '@/server/budget-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { SectionHeader } from '../ui/section-header';
import { Field, Input } from '../ui/field';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

const NAME_MAX = 80;

/**
 * Every budget the household has: active ones first, archived below. Writers can rename and
 * archive (there is no delete: an archived budget keeps all its data).
 */
export function BudgetsList({ budgets, canWrite }: { budgets: BudgetDto[]; canWrite: boolean }) {
  const t = useTranslations('budgetList');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const [renaming, setRenaming] = useState<BudgetDto | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const active = budgets.filter((b) => b.status === 'active');
  const archived = budgets.filter((b) => b.status === 'archived');

  function archive(b: BudgetDto, next: boolean) {
    setBusy(b.id);
    startTransition(async () => {
      const result = await setBudgetArchivedAction(b.id, next);
      setBusy(null);
      if (!result.ok) return toast.error(failure(result));
      toast.success(next ? t('archivedDone') : t('restored'));
      router.refresh();
    });
  }

  function saveName() {
    if (!renaming) return;
    const trimmed = name.trim();
    if (!trimmed) return setError(t('nameRequired'));
    setError(null);
    startTransition(async () => {
      const result = await renameBudgetAction(renaming.id, trimmed);
      if (!result.ok) return setError(failure(result));
      toast.success(t('renamed'));
      setRenaming(null);
      router.refresh();
    });
  }

  const group = (title: string, id: string, list: BudgetDto[]) =>
    list.length === 0 ? null : (
      <section aria-labelledby={id} className="grid grid-cols-1 gap-2">
        <SectionHeader id={id} title={title} count={list.length} />
        <Card as="ul" pad="none" className="divide-y divide-border overflow-hidden">
          {list.map((b) => (
            <li
              key={b.id}
              className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 md:px-5"
            >
              <div className="min-w-0 flex-1 py-1">
                <p className="truncate text-base font-medium" title={b.name}>
                  {truncateName(b.name, 60)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatBudgetRange(b.startMonth, locale)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Link
                  href={`/budget?${new URLSearchParams({ month: monthParam(b.startMonth), budget: b.id }).toString()}`}
                  className="inline-flex min-h-11 items-center rounded-md px-3 text-base font-medium text-primary-text hover:underline md:pointer-fine:min-h-9 md:pointer-fine:text-sm"
                >
                  {t('open')}
                  <span className="sr-only"> {b.name}</span>
                </Link>
                {canWrite ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('rename', { name: truncateName(b.name) })}
                      title={t('renameShort')}
                      onClick={() => {
                        setRenaming(b);
                        setName(b.name);
                        setError(null);
                      }}
                    >
                      <Pencil className="size-5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      loading={busy === b.id}
                      aria-label={
                        b.status === 'active'
                          ? t('archive', { name: truncateName(b.name) })
                          : t('unarchive', { name: truncateName(b.name) })
                      }
                      title={b.status === 'active' ? t('archiveShort') : t('restore')}
                      onClick={() => archive(b, b.status === 'active')}
                    >
                      {busy === b.id ? null : b.status === 'active' ? (
                        <Archive className="size-5" aria-hidden="true" />
                      ) : (
                        <ArchiveRestore className="size-5" aria-hidden="true" />
                      )}
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </Card>
      </section>
    );

  return (
    <div className="grid grid-cols-1 gap-6">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      {group(t('active'), 'budgets-active', active)}
      {group(t('archived'), 'budgets-archived', archived)}

      <Sheet
        open={renaming !== null}
        onOpenChange={(open) => (open ? undefined : setRenaming(null))}
        title={t('renameTitle')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              {common('cancel')}
            </Button>
            <Button loading={pending} onClick={saveName}>
              {common('save')}
            </Button>
          </div>
        }
      >
        <form
          method="post"
          className="grid grid-cols-1 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveName();
          }}
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Field label={t('name')}>
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={NAME_MAX}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
        </form>
      </Sheet>
    </div>
  );
}
