'use client';

import { MoreHorizontal, NotebookText, Settings2, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { useReportFailure } from '@/components/use-action-error';
import { cn } from '@/lib/cn';
import { clearAdvisorHistoryAction } from '@/server/actions/advisor';
import type { PanelName } from './advisor-panels';

const itemClass =
  'flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2';

/**
 * The header menu: advisor settings, notes, and clearing the history (after a confirmation that
 * says what stays). Settings and notes open as panels inside the chat container.
 */
export function AdvisorMenu({
  onPanel,
  onCleared,
}: {
  onPanel: (panel: PanelName) => void;
  onCleared: () => void;
}) {
  const t = useTranslations('advisor');
  const common = useTranslations('common');
  const toast = useToast();
  const report = useReportFailure();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={t('menu')}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2 data-[state=open]:bg-surface-2"
        >
          <MoreHorizontal className="size-5" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-[55] min-w-52 rounded-lg bg-surface-raised p-1 shadow-raised"
          >
            <DropdownMenu.Item className={itemClass} onSelect={() => onPanel('settings')}>
              <Settings2 className="size-4" aria-hidden="true" />
              {t('menuSettings')}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={itemClass} onSelect={() => onPanel('notes')}>
              <NotebookText className="size-4" aria-hidden="true" />
              {t('menuNotes')}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              className={cn(itemClass, 'text-negative')}
              onSelect={() => setConfirming(true)}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t('menuClear')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('clear.title')}
        description={t('clear.body')}
        confirmLabel={t('clear.confirm')}
        cancelLabel={common('cancel')}
        pending={pending}
        onConfirm={(event) => {
          event.preventDefault();
          setPending(true);
          void clearAdvisorHistoryAction().then((result) => {
            setPending(false);
            if (result.ok) {
              setConfirming(false);
              toast.success(t('clear.done'));
              onCleared();
            } else report(result);
          });
        }}
      />
    </>
  );
}
