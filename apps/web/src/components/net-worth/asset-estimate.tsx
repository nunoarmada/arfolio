'use client';

import { ExternalLink } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { aiStatus, sourceLinks, type CurrentAiEstimate } from '@/lib/net-worth-derive';
import { requestAssetEstimateAction } from '@/server/actions/net-worth';
import type { AssetDetail } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useFormatMoney } from '@/components/privacy';

/** The AI estimate behind the current value: range, confidence, the reasoning and its sources. */
function EstimateDetails({
  estimate,
  currency,
}: {
  estimate: CurrentAiEstimate;
  currency: string;
}) {
  const t = useTranslations('asset.estimate');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const links = sourceLinks(estimate.sources);
  return (
    <Card as="section" aria-labelledby="asset-estimate-title" className="grid grid-cols-1 gap-3">
      <h2 id="asset-estimate-title" className="text-card-title">
        {t('title')}
      </h2>
      <div className="grid grid-cols-1 gap-0.5">
        <p className="text-base tabular-nums">
          {t('range', {
            low: formatMoney(estimate.low, currency, locale),
            high: formatMoney(estimate.high, currency, locale),
          })}
        </p>
        <p className="text-sm text-muted-foreground">{t(`confidence.${estimate.confidence}`)}</p>
      </div>
      {estimate.rationale ? (
        <p className="max-w-[68ch] text-sm text-muted-foreground">{estimate.rationale}</p>
      ) : null}
      {links.length > 0 ? (
        <div className="grid grid-cols-1 gap-1">
          <h3 className="text-sm font-medium">{t('sources')}</h3>
          <ul className="grid grid-cols-1">
            {links.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 max-w-full items-center gap-1.5 text-sm font-medium text-primary-text underline-offset-4 hover:underline"
                >
                  {link.title ? (
                    <>
                      <span className="truncate">{link.title}</span>
                      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                        —
                      </span>
                    </>
                  ) : null}
                  <span className="shrink-0">{link.host}</span>
                  <span className="sr-only">{t('opensNew')}</span>
                  <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * What the AI valuation of an asset is doing: the estimate behind today's value, a status line,
 * and "Estimar agora" for writers.
 */
export function AssetEstimate({ detail, canWrite }: { detail: AssetDetail; canWrite: boolean }) {
  const t = useTranslations('asset.estimate');
  const field = useTranslations('asset.details.field');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, start] = useTransition();
  const { asset, aiEstimate, readiness, householdAiEnabled, current } = detail;

  const status = aiStatus({
    aiValuation: asset.aiValuation,
    householdAiEnabled,
    readiness,
    aiRequestedAt: asset.aiRequestedAt,
    aiLastError: asset.aiLastError,
    hasValue: current.hasValue,
  });
  if (!aiEstimate && !status) return null;

  function estimateNow() {
    start(async () => {
      const result = await requestAssetEstimateAction(asset.id);
      if (!result.ok) {
        toast.error(failure(result));
        return;
      }
      toast.success(t('requested'));
      router.refresh();
    });
  }

  const problem = status?.kind === 'error' || status?.kind === 'householdOff';
  const text = !status
    ? null
    : status.kind === 'missing'
      ? t('status.missing', { fields: status.fields.map((key) => field(key)).join(', ') })
      : status.kind === 'error'
        ? t(`status.error.${status.code as 'api_error'}`)
        : t(`status.${status.kind}`);

  return (
    <div className="grid grid-cols-1 gap-3">
      {aiEstimate ? <EstimateDetails estimate={aiEstimate} currency={asset.currency} /> : null}
      {status && text ? (
        problem || status.kind === 'missing' ? (
          <Alert
            tone={status.kind === 'error' ? 'warning' : 'info'}
            action={
              status.kind === 'householdOff' ? (
                <Link
                  href="/settings/household#ai"
                  className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                >
                  {t('status.householdOffLink')}
                </Link>
              ) : status.kind === 'missing' && canWrite ? (
                <Link
                  href={`/net-worth/assets/${asset.id}/edit`}
                  className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
                >
                  {t('status.completeDetails')}
                </Link>
              ) : undefined
            }
          >
            {text}
          </Alert>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {text}
          </p>
        )
      ) : null}
      {canWrite && asset.aiValuation && readiness.eligible && householdAiEnabled ? (
        <Button
          variant="outline"
          className="w-full md:w-auto md:justify-self-start"
          loading={pending}
          onClick={estimateNow}
        >
          {t('now')}
        </Button>
      ) : null}
    </div>
  );
}
