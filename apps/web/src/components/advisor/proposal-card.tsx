'use client';

import { parseMoneyInput } from '@arfolio/core';
import { AlertCircle, Check, ListFilter, Tag, Target, Wallet, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { useHouseholdFormat } from '@/components/household-format';
import { useFormatMoney } from '@/components/privacy';
import { StatusChip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, IconTile } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useFailureMessage } from '@/components/use-action-error';
import { cn } from '@/lib/cn';
import { applyAdvisorProposalAction, dismissAdvisorProposalAction } from '@/server/actions/advisor';
import { PrivateText } from './private-text';
import { proposalReason, type ChatProposal, type ProposalStatus } from './advisor-types';

const ICONS: Record<string, LucideIcon> = {
  goal_create: Target,
  goal_update: Target,
  budget_line_amount: Wallet,
  rule_create: ListFilter,
  transaction_categorise: Tag,
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

type Detail = { key: string; label?: string; value: ReactNode };

/** "2027-03-15" as a long date in the household's language. */
function dateLabel(value: unknown, locale: string): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(text(value));
  if (!match) return text(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))),
  );
}

/**
 * What the proposal does, in one sentence, and every change Apply would make as detail rows. The
 * draft carries ids; the names and the transaction come from the server (`proposal.display`), so
 * the member sees what they are approving. Amounts go through the money formatter, so privacy
 * mode masks them; free text read from the member's data is blurred like the model's reason.
 */
function useSummary(proposal: ChatProposal): { summary: string; details: Detail[] } {
  const t = useTranslations('advisor.proposal');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const p = proposal.payload;
  const d = proposal.display;
  const amount = (value: unknown): string => {
    const raw = text(value);
    try {
      return formatMoney(parseMoneyInput(raw, currency), currency, locale);
    } catch {
      // Not a valid amount (the server vets them): show what the draft says rather than nothing.
      return raw;
    }
  };
  const details: Detail[] = [];
  const add = (key: string, label: string, value: ReactNode) => details.push({ key, label, value });
  const draftFields = () => {
    if (p.targetAmount) add('target', t('detail.targetAmount'), amount(p.targetAmount));
    if (p.targetDate) add('date', t('detail.targetDate'), dateLabel(p.targetDate, locale));
    if (p.monthlyContribution) {
      add('monthly', t('detail.monthlyContribution'), amount(p.monthlyContribution));
    }
  };

  switch (proposal.kind) {
    case 'goal_create':
      draftFields();
      if (d?.accountName) add('account', t('detail.account'), d.accountName);
      return { summary: t('summary.goalCreate', { name: text(p.name) }), details };
    case 'goal_update':
      draftFields();
      return {
        summary: d?.goalName
          ? t('summary.goalUpdateNamed', { name: d.goalName })
          : t('summary.goalUpdate'),
        details,
      };
    case 'budget_line_amount': {
      const from = monthLabel(p.fromMonth, locale);
      return {
        summary:
          d?.lineName && d.toMonth
            ? t('summary.budgetLineNamed', {
                line: d.lineName,
                amount: amount(p.monthlyAmount),
                from,
                to: monthLabel(d.toMonth, locale),
              })
            : t('summary.budgetLine', { amount: amount(p.monthlyAmount), month: from }),
        details,
      };
    }
    case 'rule_create': {
      const c = isRecord(p.condition) ? p.condition : {};
      const minor = (value: unknown) =>
        typeof value === 'number' ? formatMoney(value, currency, locale) : text(value);
      const parts: string[] = [];
      if (c.descriptionContains) {
        parts.push(t('condition.descriptionContains', { text: text(c.descriptionContains) }));
      }
      if (c.descriptionPattern) {
        parts.push(t('condition.descriptionPattern', { text: text(c.descriptionPattern) }));
      }
      if (c.counterpartyContains) {
        parts.push(t('condition.counterpartyContains', { text: text(c.counterpartyContains) }));
      }
      if (c.amountMin !== undefined) {
        parts.push(t('condition.amountMin', { amount: minor(c.amountMin) }));
      }
      if (c.amountMax !== undefined) {
        parts.push(t('condition.amountMax', { amount: minor(c.amountMax) }));
      }
      if (c.direction === 'in') parts.push(t('condition.directionIn'));
      if (c.direction === 'out') parts.push(t('condition.directionOut'));
      if (d?.accountNames?.length) {
        parts.push(t('condition.accounts', { names: d.accountNames.join(', ') }));
      }
      if (parts.length > 0) {
        add('condition', t('detail.condition'), <PrivateText>{parts.join(', ')}</PrivateText>);
      }
      if (d?.categoryName) add('category', t('detail.category'), d.categoryName);
      return { summary: t('summary.ruleCreate', { name: text(p.name) }), details };
    }
    case 'transaction_categorise': {
      const tx = d?.transaction;
      if (tx) {
        add('date', t('detail.date'), dateLabel(tx.bookedOn, locale));
        add('amount', t('detail.amount'), formatMoney(tx.amount, tx.currency, locale));
        add('description', t('detail.description'), <PrivateText>{tx.description}</PrivateText>);
      }
      if (p.applyToMerchant === true) {
        details.push({ key: 'merchant', value: t('detail.merchantAll') });
      }
      return {
        summary: d?.categoryName
          ? t('summary.categoriseTo', { category: d.categoryName })
          : t('summary.categorise'),
        details,
      };
    }
    default:
      return { summary: '', details };
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
  const { summary, details } = useSummary(proposal);
  const errorId = useId();
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server judged the amount unacceptable: applying it again would only be refused again.
  const [refused, setRefused] = useState(false);

  const reason = proposalReason(proposal);
  const Icon = ICONS[proposal.kind] ?? Target;
  const { basis, status } = proposal;
  const dismissed = status === 'dismissed';

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
      else {
        setError(t('notAcceptable'));
        setRefused(true);
      }
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
        <IconTile icon={Icon} tone={dismissed ? 'neutral' : 'primary'} />
        <p
          className={cn(
            'min-w-0 flex-1 break-words text-card-title',
            dismissed && 'text-muted-foreground',
          )}
        >
          {summary}
        </p>
      </div>
      {details.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {details.map((row) =>
            row.label ? (
              <div key={row.key} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="min-w-0 break-words tabular-nums">{row.value}</dd>
              </div>
            ) : (
              <dd key={row.key} className="col-span-2 min-w-0 break-words">
                {row.value}
              </dd>
            ),
          )}
        </dl>
      ) : null}
      {reason ? (
        <PrivateText className="break-words text-sm text-muted-foreground">{reason}</PrivateText>
      ) : null}
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
            disabled={busy !== null}
            loading={busy === 'dismiss'}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void dismiss()}
          >
            {common('dismiss')}
          </Button>
          <Button
            disabled={busy === 'dismiss' || refused}
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
