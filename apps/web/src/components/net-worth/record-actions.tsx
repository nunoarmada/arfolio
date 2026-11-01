'use client';

import { MoreHorizontal, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition, type ReactNode } from 'react';
import { undoAssetDisposalAction, unsettleLiabilityAction } from '@/server/actions/net-worth';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { useReportFailure } from '../use-action-error';
import { DeleteRecord } from './delete-record';

const item =
  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2 lg:pointer-fine:min-h-9 lg:pointer-fine:text-sm';

/** Toolbar buttons: a full row each on the narrowest phones, side by side from 360px. */
const ACTION = 'max-[359px]:w-full';

/**
 * The toolbar at the foot of a record's hero card: the page's primary action (Atualizar) and the
 * state changes (Vender, Abater, Liquidar or their undo). The note explains what an undo leaves
 * behind.
 */
function ActionsToolbar({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2">
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
        {children}
      </div>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/**
 * The record's "more actions" menu (owners), in the hero card's corner: it holds Apagar…, the
 * destructive entry point, whose confirmation returns focus to the menu's button on cancel.
 */
export function RecordMenu({
  mode,
  id,
  name,
  live,
  hasLinkedCredits = false,
}: {
  mode: 'asset' | 'liability';
  id: string;
  name: string;
  /** Not yet sold, written off or settled. */
  live: boolean;
  hasLinkedCredits?: boolean;
}) {
  const common = useTranslations('common');
  const del = useTranslations('deleteRecord');
  const moreId = useId();
  const [deleting, setDeleting] = useState(false);
  // The dialog opens from a menu item, so it has no Trigger: Radix would drop focus on <body>.
  const returnFocus = (e: Event) => {
    const target = document.getElementById(moreId);
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            id={moreId}
            variant="ghost"
            size="icon"
            aria-label={common('moreActions')}
            className="-my-1 -mr-2 shrink-0"
          >
            <MoreHorizontal className="size-5" aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-52 rounded-lg bg-surface-raised p-1 shadow-raised"
          >
            <DropdownMenu.Item
              className={`${item} text-negative`}
              onSelect={() => setDeleting(true)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {del('trigger')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DeleteRecord
        mode={mode}
        id={id}
        name={name}
        live={live}
        hasLinkedCredits={hasLinkedCredits}
        open={deleting}
        onOpenChange={setDeleting}
        onCloseAutoFocus={returnFocus}
      />
    </>
  );
}

/**
 * Asset page actions. Live: Atualizar valor (`primary`), Vender, Abater (writers). Sold or
 * written off: Anular (no confirmation, it is reversible). Apagar is in `RecordMenu`. Viewers
 * see none of it.
 */
export function AssetActions({
  asset,
  disposalKind,
  settledLinkedCount,
  canWrite,
  primary,
  onSell,
  onWriteOff,
  onUndone,
}: {
  asset: { id: string };
  disposalKind: 'sold' | 'written_off' | null;
  settledLinkedCount: number;
  canWrite: boolean;
  /** The page's main action, first in the toolbar. */
  primary?: ReactNode;
  onSell: () => void;
  onWriteOff: () => void;
  /** Called after an undo succeeded, before the page refreshes. */
  onUndone: () => void;
}) {
  const t = useTranslations('asset.actions');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [pending, start] = useTransition();
  if (!canWrite) return null;

  function undo() {
    start(async () => {
      const result = await undoAssetDisposalAction(asset.id);
      if (!result.ok) {
        report(result);
        return;
      }
      toast.success(t(disposalKind === 'sold' ? 'saleUndone' : 'writeOffUndone'));
      onUndone();
      router.refresh();
    });
  }

  return (
    <ActionsToolbar
      label={t('group')}
      note={disposalKind && settledLinkedCount > 0 ? t('settledStay') : null}
    >
      {disposalKind ? (
        <Button variant="outline" className={ACTION} loading={pending} onClick={undo}>
          {pending ? t('undoing') : t(disposalKind === 'sold' ? 'undoSale' : 'undoWriteOff')}
        </Button>
      ) : (
        <>
          {primary}
          <Button variant="outline" className={ACTION} onClick={onSell}>
            {t('sell')}
          </Button>
          <Button variant="outline" className={ACTION} onClick={onWriteOff}>
            {t('writeOff')}
          </Button>
        </>
      )}
    </ActionsToolbar>
  );
}

/**
 * Liability page actions: Atualizar saldo (`primary`), Liquidar or Anular liquidação (writers).
 * Apagar is in `RecordMenu`.
 */
export function LiabilityActions({
  liability,
  settled,
  zeroStays,
  canWrite,
  primary,
  onSettle,
  onUndone,
}: {
  liability: { id: string };
  settled: boolean;
  /** A zero balance written by the settlement is still in the history. */
  zeroStays: boolean;
  canWrite: boolean;
  /** The page's main action, first in the toolbar. */
  primary?: ReactNode;
  onSettle: () => void;
  /** Called after an undo succeeded, before the page refreshes. */
  onUndone: () => void;
}) {
  const t = useTranslations('liability.actions');
  const router = useRouter();
  const toast = useToast();
  const report = useReportFailure();
  const [pending, start] = useTransition();
  if (!canWrite) return null;

  function undo() {
    start(async () => {
      const result = await unsettleLiabilityAction(liability.id);
      if (!result.ok) {
        report(result);
        return;
      }
      toast.success(t('unsettled'));
      onUndone();
      router.refresh();
    });
  }

  return (
    <ActionsToolbar label={t('group')} note={settled && zeroStays ? t('zeroStays') : null}>
      {settled ? (
        <Button variant="outline" className={ACTION} loading={pending} onClick={undo}>
          {pending ? t('undoing') : t('undoSettlement')}
        </Button>
      ) : (
        <>
          {primary}
          <Button variant="outline" className={ACTION} onClick={onSettle}>
            {t('settle')}
          </Button>
        </>
      )}
    </ActionsToolbar>
  );
}
