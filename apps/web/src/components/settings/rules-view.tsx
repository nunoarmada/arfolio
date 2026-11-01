'use client';

import {
  ChevronDown,
  ChevronUp,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deleteRuleAction, reorderRulesAction, updateRuleAction } from '@/server/actions/rules';
import type { AccountDto, CategoryDto, GroupDto, RuleDto } from '@/server/serialize';
import { EmptyState } from '../empty-state';
import { useHouseholdFormat } from '../household-format';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';
import { ApplyRuleDialog } from './apply-rule-dialog';
import { RuleFormSheet } from './rule-form-sheet';
import { useFormatMoney } from '@/components/privacy';

const menuItem =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

const moreId = (ruleId: string) => `rule-more-${ruleId}`;

/** "Se a descrição contém 'X' e é uma saída → Supermercado", in plain words. */
function useRuleSummary(accounts: AccountDto[]) {
  const t = useTranslations('rules.summary');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  return (rule: RuleDto, categoryName: string): string => {
    const c = rule.condition;
    const parts: string[] = [];
    if (c.descriptionContains) parts.push(t('contains', { text: c.descriptionContains }));
    if (c.descriptionPattern) parts.push(t('matches', { text: c.descriptionPattern }));
    if (c.counterpartyContains) parts.push(t('counterparty', { text: c.counterpartyContains }));
    if (c.direction) parts.push(t(c.direction === 'in' ? 'in' : 'out'));
    const money = (minor: number) => formatMoney(minor, currency, locale);
    if (c.amountMin !== undefined && c.amountMax !== undefined) {
      parts.push(t('between', { min: money(c.amountMin), max: money(c.amountMax) }));
    } else if (c.amountMin !== undefined) {
      parts.push(t('atLeast', { amount: money(c.amountMin) }));
    } else if (c.amountMax !== undefined) {
      parts.push(t('atMost', { amount: money(c.amountMax) }));
    }
    if (c.accountIds?.length) {
      const names = c.accountIds
        .map((id) => accounts.find((a) => a.id === id)?.name)
        .filter(Boolean);
      parts.push(t('accounts', { names: names.join(', ') }));
    }
    return t('line', { conditions: parts.join(t('and')), category: categoryName });
  };
}

/** The rules in the order they apply, with a plain summary, an on/off switch and up/down buttons. */
export function RulesView({
  rules,
  accounts,
  groups,
  categories,
  canWrite,
}: {
  rules: RuleDto[];
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
  canWrite: boolean;
}) {
  const t = useTranslations('rules');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const summary = useRuleSummary(accounts);
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<{ rule?: RuleDto } | null>(null);
  const [applying, setApplying] = useState<{ rule: RuleDto; open: boolean } | null>(null);
  const [deleting, setDeleting] = useState<{ rule: RuleDto; open: boolean } | null>(null);
  const refresh = () => router.refresh();

  function move(id: string, delta: -1 | 1) {
    const ids = rules.map((r) => r.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to]!, ids[at]!];
    startTransition(async () => {
      const result = await reorderRulesAction(ids);
      if (!result.ok) return report(result);
      refresh();
    });
  }

  function toggle(rule: RuleDto, enabled: boolean) {
    startTransition(async () => {
      const result = await updateRuleAction(rule.id, { enabled });
      if (!result.ok) return report(result);
      refresh();
    });
  }

  function remove(rule: RuleDto) {
    startTransition(async () => {
      const result = await deleteRuleAction(rule.id);
      if (!result.ok) return report(result);
      toast.success(t('deleted'));
      refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="max-w-[68ch] text-sm text-muted-foreground">{t('intro')}</p>
      {canWrite ? (
        <Button id="rules-add" className="justify-self-start" onClick={() => setEditing({})}>
          <Plus className="size-4" aria-hidden="true" />
          {t('add')}
        </Button>
      ) : null}

      {rules.length === 0 ? (
        <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card">
          {rules.map((rule, index) => {
            const category = categories.find((c) => c.id === rule.categoryId);
            const labelId = `rule-${rule.id}`;
            return (
              <li
                key={rule.id}
                className="grid grid-cols-1 gap-1 py-2 pl-4 pr-1 md:flex md:items-start md:gap-2 md:pl-5 md:pr-2"
              >
                <div className="grid grid-cols-1 min-w-0 flex-1 gap-0.5 py-1.5">
                  <p
                    id={labelId}
                    className={rule.enabled ? 'text-base' : 'text-base text-muted-foreground'}
                  >
                    {summary(rule, category?.name ?? '')}
                  </p>
                  <p className="truncate text-sm text-muted-foreground">
                    {rule.name}
                    {rule.enabled ? '' : ` · ${t('disabled')}`}
                  </p>
                </div>
                {canWrite ? (
                  <div className="flex items-center justify-end md:shrink-0">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={(next) => toggle(rule, next)}
                      aria-labelledby={labelId}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('moveUp', { name: rule.name })}
                      disabled={index === 0}
                      onClick={() => move(rule.id, -1)}
                    >
                      <ChevronUp className="size-5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('moveDown', { name: rule.name })}
                      disabled={index === rules.length - 1}
                      onClick={() => move(rule.id, 1)}
                    >
                      <ChevronDown className="size-5" aria-hidden="true" />
                    </Button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button
                          id={moreId(rule.id)}
                          variant="ghost"
                          size="icon"
                          aria-label={t('more', { name: rule.name })}
                        >
                          <MoreHorizontal className="size-5" aria-hidden="true" />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={6}
                          className="z-50 min-w-60 max-w-[calc(100vw-2rem)] rounded-lg bg-surface-raised p-1 shadow-raised"
                        >
                          <DropdownMenu.Item
                            className={`${menuItem} ${rule.enabled ? '' : '!cursor-default'}`}
                            // Not Radix `disabled`: that drops the item from the keyboard order, so
                            // the reason it cannot be used would never be read out.
                            aria-disabled={rule.enabled ? undefined : true}
                            aria-describedby={rule.enabled ? undefined : `${moreId(rule.id)}-hint`}
                            onSelect={(e) => {
                              if (!rule.enabled) return e.preventDefault();
                              setApplying({ rule, open: true });
                            }}
                          >
                            <ListChecks
                              className={`size-5 shrink-0 ${rule.enabled ? '' : 'opacity-60'}`}
                              aria-hidden="true"
                            />
                            <span className="grid grid-cols-1">
                              <span className={rule.enabled ? '' : 'opacity-60'}>
                                {t('apply.menu')}
                              </span>
                              {rule.enabled ? null : (
                                <span
                                  id={`${moreId(rule.id)}-hint`}
                                  className="text-sm text-muted-foreground"
                                >
                                  {t('apply.needsEnabled')}
                                </span>
                              )}
                            </span>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={menuItem}
                            onSelect={() => setEditing({ rule })}
                          >
                            <Pencil className="size-5 shrink-0" aria-hidden="true" />
                            {t('editShort')}
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="my-1 h-px bg-border" />
                          <DropdownMenu.Item
                            className={`${menuItem} text-negative`}
                            onSelect={() => setDeleting({ rule, open: true })}
                          >
                            <Trash2 className="size-5 shrink-0" aria-hidden="true" />
                            {t('deleteShort')}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {canWrite && applying ? (
        <ApplyRuleDialog
          rule={applying.rule}
          categoryName={categories.find((c) => c.id === applying.rule.categoryId)?.name ?? ''}
          open={applying.open}
          onOpenChange={(open) => setApplying({ ...applying, open })}
          returnFocusId={moreId(applying.rule.id)}
        />
      ) : null}
      {canWrite && deleting ? (
        <ConfirmDialog
          open={deleting.open}
          onOpenChange={(open) => setDeleting({ ...deleting, open })}
          title={t('deleteTitle', { name: deleting.rule.name })}
          description={t('deleteBody')}
          confirmLabel={t('deleteConfirm')}
          cancelLabel={common('cancel')}
          onConfirm={() => remove(deleting.rule)}
          onCloseAutoFocus={(e) => {
            // The deleted row is gone: focus the list's own entry point instead of the page top.
            const target =
              document.getElementById(moreId(deleting.rule.id)) ??
              document.getElementById('rules-add');
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
        />
      ) : null}

      {canWrite ? (
        <RuleFormSheet
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
          rule={editing?.rule}
          accounts={accounts}
          groups={groups}
          categories={categories}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
