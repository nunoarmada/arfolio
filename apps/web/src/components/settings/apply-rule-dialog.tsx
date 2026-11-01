'use client';

import { AlertDialog as Primitive } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { previewRuleApplicationAction } from '@/server/actions/rules';
import type { RuleDto } from '@/server/serialize';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { useFailureMessage } from '../use-action-error';
import { useApplyRule } from './use-apply-rule';

type Preview = { matches: number; changes: number };
type Phase = { kind: 'loading' } | { kind: 'ready'; preview: Preview } | { kind: 'error' };

/**
 * "Aplicar a regra a movimentos existentes?": looks up what would change before asking, and only
 * offers the action when something would. Errors stay in the dialog; success closes it, hands
 * focus back to the row's menu button and raises the "Anular" toast.
 */
export function ApplyRuleDialog({
  rule,
  categoryName,
  open,
  onOpenChange,
  returnFocusId,
}: {
  rule: RuleDto;
  categoryName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element that gets focus back on close (the row's "⋯" button). */
  returnFocusId: string;
}) {
  const t = useTranslations('rules.apply');
  const common = useTranslations('common');
  const failure = useFailureMessage();
  const apply = useApplyRule();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [applying, setApplying] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const runId = useRef(0);

  const load = useCallback(() => {
    const id = (runId.current += 1);
    setPhase({ kind: 'loading' });
    void (async () => {
      let next: Phase;
      try {
        const result = await previewRuleApplicationAction(rule.id);
        next = result.ok ? { kind: 'ready', preview: result.data } : { kind: 'error' };
      } catch {
        next = { kind: 'error' };
      }
      if (id === runId.current) setPhase(next);
    })();
  }, [rule.id]);

  useEffect(() => {
    if (!open) {
      runId.current += 1;
      return;
    }
    setError(null);
    setApplying(false);
    setSlow(false);
    load();
  }, [open, attempt, load]);

  useEffect(() => {
    if (!applying) return;
    const timer = window.setTimeout(() => setSlow(true), 2000);
    return () => window.clearTimeout(timer);
  }, [applying]);

  // The primary action (or "Fechar" when there is nothing to do) takes focus once it is known.
  const readyKind = phase.kind === 'ready' ? phase.preview.changes > 0 : null;
  useEffect(() => {
    if (readyKind === null) return;
    (readyKind ? confirmRef : closeRef).current?.focus();
  }, [readyKind]);

  async function confirm() {
    if (applying) return;
    setApplying(true);
    setSlow(false);
    setError(null);
    const outcome = await apply(rule.id, categoryName);
    if (!outcome.ok) {
      setApplying(false);
      // A role problem is explained as such; any other failure means nothing was changed.
      setError(outcome.code === 'forbidden' ? failure(outcome) : t('error'));
      return;
    }
    if (outcome.changed === 0) {
      // Nothing left to change: the rule was turned off, or someone else just applied it.
      setApplying(false);
      setError(t('disabledNow'));
      load();
      return;
    }
    setApplying(false);
    onOpenChange(false);
  }

  const preview = phase.kind === 'ready' ? phase.preview : null;
  const none = preview !== null && preview.changes === 0;

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => (applying ? undefined : onOpenChange(next))}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Primitive.Content
          onEscapeKeyDown={(e) => applying && e.preventDefault()}
          onCloseAutoFocus={(e) => {
            const target = document.getElementById(returnFocusId);
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 grid grid-cols-1 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-surface-raised p-5 shadow-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <Primitive.Title className="text-lg font-semibold">{t('title')}</Primitive.Title>
          <Primitive.Description asChild>
            <div
              className="grid grid-cols-1 gap-2"
              aria-busy={phase.kind === 'loading'}
              aria-live="polite"
            >
              {phase.kind === 'loading' ? (
                <>
                  <Skeleton className="h-5 w-4/5 rounded-md" />
                  <Skeleton className="h-5 w-3/5 rounded-md" />
                </>
              ) : phase.kind === 'error' ? (
                <Alert
                  tone="error"
                  action={
                    <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                      {common('retry')}
                    </Button>
                  }
                >
                  {t('previewError')}
                </Alert>
              ) : none ? (
                <>
                  <p className="text-base font-medium">{t('noneTitle')}</p>
                  <p className="text-base text-muted-foreground">
                    {phase.preview.matches > 0
                      ? t('noneAlready', { count: phase.preview.matches, category: categoryName })
                      : t('noneMatch')}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-medium">
                    {t('willChange', { count: phase.preview.changes, category: categoryName })}
                  </p>
                  {phase.preview.matches > phase.preview.changes ? (
                    <p className="text-base text-muted-foreground">
                      {t('alreadySet', { count: phase.preview.matches - phase.preview.changes })}
                    </p>
                  ) : null}
                  <p className="text-sm text-muted-foreground">{t('note')}</p>
                </>
              )}
            </div>
          </Primitive.Description>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {none ? (
              <Primitive.Cancel asChild>
                <Button ref={closeRef} variant="outline">
                  {common('close')}
                </Button>
              </Primitive.Cancel>
            ) : (
              <>
                <Primitive.Cancel asChild>
                  <Button variant="outline" disabled={applying}>
                    {common('cancel')}
                  </Button>
                </Primitive.Cancel>
                {phase.kind === 'error' ? null : (
                  <Button
                    ref={confirmRef}
                    loading={applying}
                    disabled={preview === null}
                    onClick={() => void confirm()}
                  >
                    {applying
                      ? slow
                        ? t('applyingSlow')
                        : t('applying')
                      : preview
                        ? t('confirm', { count: preview.changes })
                        : t('confirmPending')}
                  </Button>
                )}
              </>
            )}
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
