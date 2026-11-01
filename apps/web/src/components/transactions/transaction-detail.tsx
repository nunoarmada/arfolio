'use client';

import { ArrowLeftRight, ChevronDown, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { formatDate, formatDateTime } from '@/lib/dates';
import type { TxExtras } from '@/server/transactions-data';
import { Alert } from '../ui/alert';
import { AiBadge } from '../ai-badge';
import { ConfidenceLabel } from '../confidence-label';
import { confidenceBand } from '@/lib/ai-confidence';
import {
  deleteManualTransactionAction,
  getTransactionAction,
  getTxExtrasAction,
  markTransferAction,
  saveNotesAction,
  undoAiCategorisationAction,
  unlinkTransferAction,
} from '@/server/actions/transactions';
import type { AccountDto, CategoryDto, GroupDto, TxDto } from '@/server/serialize';
import { AccountBadge } from '../account-badge';
import { CategoryPicker } from '../category-picker';
import { CategoryChip } from '../category-icon';
import { MerchantAvatar } from '../merchant-avatar';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';
import { moneyKindOf } from '@/lib/transaction-display';
import { buildDetails } from '@/lib/transaction-details-view';
import { cn } from '@/lib/cn';
import { Row } from './detail-row';
import { DetailFieldRow } from './transaction-detail-fields';
import { useCategorise } from './use-categorise';
import { useTxTitle } from './use-tx-title';

/**
 * Everything about one movement: header, fields, category (one tap to change), notes, the
 * transfer link and, for manual rows, delete. Rendered inside a sheet or as a full page.
 */
export function TransactionDetail({
  tx,
  accounts,
  categories,
  groups,
  recentIds,
  canWrite,
  onChange,
  onDeleted,
  onOpenOther,
  onOthersChanged,
}: {
  tx: TxDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  groups: GroupDto[];
  recentIds: string[];
  canWrite: boolean;
  /** Called with the saved row, and with its transfer partner when that changed too. */
  onChange: (tx: TxDto) => void;
  onDeleted: () => void;
  /** Opens the other leg of a transfer. */
  onOpenOther?: (id: string) => void;
  /** A category change also touched other rows of the merchant (or undid that): reload lists. */
  onOthersChanged?: () => void;
}) {
  const t = useTranslations('transactions');
  const titleOf = useTxTitle();
  const aiT = useTranslations('ai');
  const common = useTranslations('common');
  const toast = useToast();
  const report = useReportFailure();
  const { locale, timeZone } = useHouseholdFormat();
  const categorise = useCategorise(categories);
  const [extras, setExtras] = useState<TxExtras | null>(null);
  const [extrasFailed, setExtrasFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notes, setNotes] = useState(tx.notes ?? '');
  const [notesSaved, setNotesSaved] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const [busy, startTransition] = useTransition();
  const savedNotes = useRef(tx.notes ?? '');

  const account = accounts.find((a) => a.id === tx.accountId);
  const category = categories.find((c) => c.id === tx.categoryId);
  const isTransfer = tx.transferGroupId !== null;
  const kind = moneyKindOf(tx);

  const loadExtras = useCallback(() => {
    let alive = true;
    setExtras(null);
    setExtrasFailed(false);
    void getTxExtrasAction(tx.id).then((r) => {
      if (!alive) return;
      if (r.ok) setExtras(r.data);
      else setExtrasFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [tx.id, tx.transferGroupId]);
  useEffect(() => loadExtras(), [loadExtras]);

  useEffect(() => setMoreOpen(false), [tx.id]);

  useEffect(() => {
    setNotes(tx.notes ?? '');
    savedNotes.current = tx.notes ?? '';
  }, [tx.id, tx.notes]);

  const saveNotes = useCallback(async () => {
    if (notes === savedNotes.current) return;
    const result = await saveNotesAction(tx.id, notes);
    if (!result.ok) return report(result);
    savedNotes.current = result.data.notes ?? '';
    onChange(result.data);
    setNotesSaved(true);
    window.setTimeout(() => setNotesSaved(false), 2500);
  }, [notes, onChange, report, tx.id]);

  async function refresh(...ids: string[]) {
    for (const id of ids) {
      const fresh = await getTransactionAction(id);
      if (fresh.ok) onChange(fresh.data);
    }
  }

  function markAs(partner: TxDto) {
    startTransition(async () => {
      const result = await markTransferAction(tx.id, partner.id);
      if (!result.ok) return report(result);
      await refresh(tx.id, partner.id);
      toast.success(t('transferMarked'));
    });
  }

  function unlink() {
    const partnerId = extras?.transferLeg?.id;
    startTransition(async () => {
      const result = await unlinkTransferAction(tx.transferGroupId!);
      if (!result.ok) return report(result);
      await refresh(...(partnerId ? [tx.id, partnerId] : [tx.id]));
      toast.success(t('transferUnlinked'));
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteManualTransactionAction(tx.id);
      if (!result.ok) return report(result);
      toast.success(t('deleted'));
      onDeleted();
    });
  }

  function undoAi() {
    startTransition(async () => {
      const result = await undoAiCategorisationAction(tx.id);
      if (!result.ok) {
        if (result.code === 'ai_changed') toast.error(aiT('changed'));
        else report(result);
        return;
      }
      const back = result.data;
      onChange(back);
      toast.success(aiT('undone'), {
        label: t('undo'),
        onClick: () => {
          if (!back.aiSuggestedCategoryId) return;
          void categorise(
            back,
            back.aiSuggestedCategoryId,
            { applyToMerchant: false, createRule: false },
            { onApplied: (saved) => onChange(saved) },
          );
        },
      });
    });
  }

  const provenance = (() => {
    if (!tx.categoryId && !isTransfer) return null;
    switch (tx.categorisedBy) {
      case 'rule':
        return t('by.rule');
      case 'memory':
        return t('by.memory');
      case 'ai':
        return t('by.ai');
      case 'user':
        return tx.editedAt
          ? t('by.userOn', { date: formatDateTime(tx.editedAt, locale, timeZone) })
          : t('by.user');
      default:
        return null;
    }
  })();

  const model = useMemo(
    () => buildDetails(tx, extras?.details, locale, timeZone),
    [tx, extras?.details, locale, timeZone],
  );

  const partnerAccountName = extras?.transferLeg?.accountName;

  return (
    <div className="grid grid-cols-1 gap-5">
      <header className="flex items-start gap-3">
        <MerchantAvatar merchant={tx.merchant} category={category} size={48} />
        <div className="grid grid-cols-1 min-w-0 flex-1 gap-1">
          <h2 className="break-words text-lg font-semibold">{titleOf(tx)}</h2>
          <p className="text-sm text-muted-foreground">
            {tx.status === 'pending'
              ? `${t('state.pending')} · ${t(`kind.${kind}`)}`
              : t(`kind.${kind}`)}
          </p>
          <MoneyAmount
            minor={tx.amount}
            currency={tx.currency}
            kind={kind}
            pending={tx.status === 'pending'}
            size="lg"
            showSign={isTransfer ? true : undefined}
            className="text-[32px] leading-10"
          />
        </div>
      </header>

      <section aria-labelledby="tx-details-title" className="grid grid-cols-1 gap-2">
        <h3 id="tx-details-title" className="text-base font-semibold">
          {t('details')}
        </h3>
        <div className="rounded-lg bg-surface shadow-card px-4">
          <dl className="divide-y" aria-busy={!extras && !extrasFailed}>
            <DetailFieldRow field={model.lead} />
            {account ? (
              <Row label={t('field.account')}>
                <AccountBadge name={account.name} className="justify-end" />
              </Row>
            ) : null}
            <Row label={t('field.status')}>
              {tx.status === 'pending' ? t('state.pending') : t('state.booked')}
            </Row>
            <Row label={t('field.category')}>
              <span className="inline-flex flex-col items-end gap-1">
                {canWrite ? (
                  <CategoryChip
                    category={category}
                    uncategorisedLabel={t('uncategorised')}
                    large
                    onClick={() => setPickerOpen(true)}
                  />
                ) : (
                  <CategoryChip category={category} uncategorisedLabel={t('uncategorised')} />
                )}
                {provenance ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
                    {tx.categorisedBy === 'ai' && tx.categoryId ? <AiBadge /> : null}
                    {provenance}
                    {canWrite && tx.categorisedBy === 'ai' && tx.categoryId && !tx.editedAt ? (
                      <Button variant="ghost" size="sm" loading={busy} onClick={undoAi}>
                        {aiT('undo')}
                      </Button>
                    ) : null}
                  </span>
                ) : null}
                {!tx.categoryId && tx.aiSuggestedCategoryId ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
                    <AiBadge />
                    <span>{aiT('suggestion')}</span>
                    {confidenceBand(tx.aiConfidence) ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <ConfidenceLabel confidence={tx.aiConfidence} />
                      </>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </Row>
            {model.main.map((field) => (
              <DetailFieldRow key={field.id} field={field} />
            ))}
          </dl>
          {model.more.length > 0 ? (
            <div className="border-t">
              <Button
                variant="ghost"
                className="-mx-2 min-h-11 w-[calc(100%+1rem)] justify-between px-2"
                aria-expanded={moreOpen}
                aria-controls={moreId}
                onClick={() => setMoreOpen((v) => !v)}
              >
                {t('moreDetails')}
                <ChevronDown
                  className={cn(
                    'size-5 text-muted-foreground transition-transform duration-[120ms] motion-reduce:transition-none',
                    moreOpen && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </Button>
              {moreOpen ? (
                <dl id={moreId} className="divide-y border-t">
                  {model.more.map((field) => (
                    <DetailFieldRow key={field.id} field={field} />
                  ))}
                </dl>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="tx-notes" className="text-sm font-medium">
            {t('field.notes')}
          </label>
          <span className="text-sm text-positive" aria-live="polite">
            {notesSaved ? t('notesSaved') : ''}
          </span>
        </div>
        <Textarea
          id="tx-notes"
          value={notes}
          maxLength={2000}
          readOnly={!canWrite}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => void saveNotes()}
        />
      </div>

      {extrasFailed ? (
        <Alert
          tone="warning"
          action={
            <Button variant="outline" size="sm" onClick={loadExtras}>
              {common('retry')}
            </Button>
          }
        >
          {t('extrasFailed')}
        </Alert>
      ) : null}

      {isTransfer ? (
        <section
          aria-labelledby="transfer-title"
          className="grid grid-cols-1 gap-3 rounded-lg bg-transfer-soft p-4"
        >
          <h3 id="transfer-title" className="flex items-center gap-2 text-base font-semibold">
            <ArrowLeftRight className="size-5 text-transfer" aria-hidden="true" />
            {partnerAccountName
              ? t(tx.amount < 0 ? 'transferTo' : 'transferFrom', { account: partnerAccountName })
              : t('transferGeneric')}
          </h3>
          {extras?.transferLeg ? (
            <button
              type="button"
              onClick={() => onOpenOther?.(extras.transferLeg!.id)}
              disabled={!onOpenOther}
              className="flex min-h-12 items-center justify-between gap-3 rounded-md bg-surface px-3 text-left"
            >
              <span className="grid grid-cols-1 min-w-0">
                <span className="truncate text-base">{extras.transferLeg.title}</span>
                <span className="truncate text-sm text-muted-foreground">
                  {formatDate(extras.transferLeg.bookingDate, locale)}
                  {` · ${extras.transferLeg.accountName}`}
                </span>
              </span>
              <MoneyAmount
                minor={extras.transferLeg.amount}
                currency={extras.transferLeg.currency}
                kind="transfer"
                showSign
              />
            </button>
          ) : null}
          {canWrite ? (
            <Button
              variant="outline"
              onClick={unlink}
              loading={busy}
              className="justify-self-start"
            >
              {t('notATransfer')}
            </Button>
          ) : null}
        </section>
      ) : canWrite && extras && extras.transferCandidates.length > 0 ? (
        <section aria-labelledby="mark-title" className="grid grid-cols-1 gap-2">
          <h3 id="mark-title" className="text-base font-semibold">
            {t('markTransfer')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('markTransferHint')}</p>
          <ul className="grid grid-cols-1 gap-2">
            {extras.transferCandidates.map((c) => (
              <li
                key={c.id}
                className="flex min-h-14 items-center justify-between gap-3 rounded-lg bg-surface shadow-card px-3 py-2"
              >
                <span className="grid grid-cols-1 min-w-0">
                  <span className="truncate text-base">{titleOf(c)}</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {formatDate(c.bookingDate, locale)} ·{' '}
                    {accounts.find((a) => a.id === c.accountId)?.name ?? ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <MoneyAmount minor={c.amount} currency={c.currency} kind="transfer" showSign />
                  <Button variant="outline" size="sm" onClick={() => markAs(c)} disabled={busy}>
                    {t('markAction')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canWrite && tx.source === 'manual' ? (
        <ConfirmDialog
          trigger={
            <Button variant="outline" className="justify-self-start text-negative">
              <Trash2 className="size-5" aria-hidden="true" />
              {t('delete')}
            </Button>
          }
          title={t('deleteTitle')}
          description={t('deleteBody')}
          confirmLabel={t('delete')}
          cancelLabel={common('cancel')}
          pending={busy}
          onConfirm={remove}
        />
      ) : null}

      {canWrite ? (
        <CategoryPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          groups={groups}
          selectedId={tx.categoryId}
          suggestions={[
            ...(tx.categoryId === null && tx.aiSuggestedCategoryId
              ? [{ categoryId: tx.aiSuggestedCategoryId, ai: { confidence: tx.aiConfidence } }]
              : []),
            ...(extras?.suggestions ?? []).filter((s) => s.categoryId !== tx.aiSuggestedCategoryId),
          ]}
          recentIds={recentIds}
          ruleLabel={extras?.ruleLabel ?? null}
          amount={tx.amount}
          notice={
            extrasFailed ? (
              <Alert
                tone="warning"
                action={
                  <Button variant="outline" size="sm" onClick={loadExtras}>
                    {common('retry')}
                  </Button>
                }
              >
                {t('extrasFailed')}
              </Alert>
            ) : undefined
          }
          onPick={(categoryId, options) => {
            setPickerOpen(false);
            void categorise(tx, categoryId, options, {
              onApplied: (saved, also) => {
                onChange(saved);
                if (also > 0) onOthersChanged?.();
              },
              onUndone: (restored, also) => {
                onChange(restored);
                if (also > 0) onOthersChanged?.();
              },
            });
          }}
        />
      ) : null}
    </div>
  );
}
