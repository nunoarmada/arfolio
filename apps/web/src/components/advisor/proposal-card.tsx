'use client';

import { parseMoneyInput } from '@arfolio/core';
import { AlertCircle, Check, ListFilter, Tag, Target, Wallet, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useHouseholdFormat } from '@/components/household-format';
import { useFormatMoney } from '@/components/privacy';
import { StatusChip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, IconTile } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useFailureMessage } from '@/components/use-action-error';
import { cn } from '@/lib/cn';
import { applyAdvisorProposalAction, dismissAdvisorProposalAction } from '@/server/actions/advisor';
import { proposalReason, type ChatProposal, type ProposalStatus } from './advisor-types';

const ICONS: Record<string, LucideIcon> = {
  goal_create: Target,
  goal_update: Target,
  budget_line_amount: Wallet,
  rule_create: ListFilter,
  transaction_categorise: Tag,
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** "2026-12" as a long month and year in the household's language. */
function monthLabel(value: unknown, locale: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text(value));
  if (!match) return text(value);
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

/**
 * What the proposal does, in one sentence. The draft carries ids, not names, so the sentence only
 * names what the draft itself names (a goal or a rule); amounts go through the money formatter so
 * privacy mode masks them.
 */
function useSummary(proposal: ChatProposal): string {
  const t = useTranslations('advisor.proposal.summary');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const p = proposal.payload;
  const amount = (value: unknown): string => {
    const raw = text(value);
    try {
      return formatMoney(parseMoneyInput(raw, currency), currency, locale);
    } catch {
      // Not a valid amount (the server vets them): show what the draft says rather than nothing.
      return raw;
    }
  };
  switch (proposal.kind) {
    case 'goal_create':
      return p.targetAmount
        ? t('goalCreateTarget', { name: text(p.name), amount: amount(p.targetAmount) })
        : t('goalCreate', { name: text(p.name) });
    case 'goal_update':
      if (p.targetAmount) return t('goalUpdateTarget', { amount: amount(p.targetAmount) });
      if (p.monthlyContribution) {
        return t('goalUpdateMonthly', { amount: amount(p.monthlyContribution) });
      }
      return t('goalUpdate');
    case 'budget_line_amount':
      return t('budgetLine', {
        amount: amount(p.monthlyAmount),
        month: monthLabel(p.fromMonth, locale),
      });
    case 'rule_create':
      return t('ruleCreate', { name: text(p.name) });
    case 'transaction_categorise':
      return t('categorise');
    default:
      return '';
  }
}

/**
 * A change the advisor suggests, inside its answer: what it would do, why, and the figures it was
 * judged against. Nothing changes until an owner or member applies it; a viewer only reads it.
 */
export function ProposalCard({
  proposal,
  canApply,
  onStatus,
  onRefresh,
}: {
  proposal: ChatProposal;
  canApply: boolean;
  /** The proposal's status changed here (applied, dismissed, or found out of date). */
  onStatus: (id: string, status: ProposalStatus) => void;
  /** The server says it is no longer pending: reload the conversation to show the truth. */
  onRefresh: () => void;
}) {
  const t = useTranslations('advisor.proposal');
  const common = useTranslations('common');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const toast = useToast();
  const failureMessage = useFailureMessage();
  const summary = useSummary(proposal);
  const errorId = useId();
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reason = proposalReason(proposal);
  const Icon = ICONS[proposal.kind] ?? Target;
  const { basis, status } = proposal;
  const resolved = status !== 'pending';

  async function apply() {
    setBusy('apply');
    setError(null);
    const result = await applyAdvisorProposalAction(proposal.id);
    setBusy(null);
    if (result.ok) {
      onStatus(proposal.id, 'applied');
      toast.success(t('appliedToast'));
    } else if (result.code === 'conflict') {
      setError(t('alreadyResolved'));
      onRefresh();
    } else if (result.code === 'validation') {
      if (result.detail?.code === 'stale') onStatus(proposal.id, 'stale');
      else setError(t('notAcceptable'));
    } else {
      setError(failureMessage(result));
    }
  }

  async function dismiss() {
    setBusy('dismiss');
    setError(null);
    const result = await dismissAdvisorProposalAction(proposal.id);
    setBusy(null);
    if (result.ok) onStatus(proposal.id, 'dismissed');
    else if (result.code === 'conflict') {
      setError(t('alreadyResolved'));
      onRefresh();
    } else setError(failureMessage(result));
  }

  return (
    <Card
      as="section"
      variant="inset"
      pad="none"
      aria-label={t('label')}
      className="grid grid-cols-1 gap-2 rounded-lg p-3"
    >
      <div className="flex items-start gap-2.5">
        <IconTile icon={Icon} tone={resolved ? 'neutral' : 'primary'} />
        <p
          className={cn(
            'min-w-0 flex-1 break-words text-card-title',
            resolved && 'text-muted-foreground',
          )}
        >
          {summary}
        </p>
      </div>
      {reason ? <p className="break-words text-sm text-muted-foreground">{reason}</p> : null}
      {basis ? (
        <p className="text-label font-normal tabular-nums text-muted-foreground">
          {t('basis', {
            months: basis.months,
            min: formatMoney(basis.min, basis.currency, locale),
            max: formatMoney(basis.max, basis.currency, locale),
            median: formatMoney(basis.median, basis.currency, locale),
          })}
        </p>
      ) : null}

      {status === 'applied' ? (
        <div>
          <StatusChip tone="positive" icon={<Check className="size-3" aria-hidden="true" />}>
            {t('applied')}
          </StatusChip>
        </div>
      ) : null}
      {status === 'dismissed' ? (
        <div>
          <StatusChip tone="neutral">{t('dismissed')}</StatusChip>
        </div>
      ) : null}
      {status === 'stale' ? (
        <>
          <div>
            <StatusChip tone="warning">{t('stale')}</StatusChip>
          </div>
          <p className="text-label font-normal text-muted-foreground">{t('staleHelp')}</p>
        </>
      ) : null}

      {status === 'pending' && canApply ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            loading={busy === 'dismiss'}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void dismiss()}
          >
            {common('dismiss')}
          </Button>
          <Button
            size="sm"
            disabled={busy === 'dismiss'}
            loading={busy === 'apply'}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void apply()}
          >
            {common('apply')}
          </Button>
        </div>
      ) : null}
      {status === 'pending' && !canApply ? (
        <p className="text-caption font-normal text-muted-foreground">{t('viewerNote')}</p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="flex items-start gap-1.5 text-label font-normal text-negative"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </Card>
  );
}
