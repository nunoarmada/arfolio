'use client';

import { KeyRound } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { dayDifference, todayIn } from '@/lib/dates';
import { claudeCodeCommand } from '@/lib/mcp-command';
import { relativeTime, zonedDate } from '@/lib/when';
import { revokeTokenAction } from '@/server/actions/integrations';
import type { TokenDto } from '@/server/integrations-data';
import { useHouseholdFormat } from '../household-format';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { CreateTokenSheet, type CreatedToken } from './create-token-sheet';
import { RevealTokenDialog } from './reveal-token-dialog';
import { RevokeDialog } from './revoke-dialog';
import { CollapsibleRow, EmptyCard, IDENT, LoadError, SectionHeader } from './shared';
import { useRowRemoval } from './use-row-removal';

const TITLE_ID = 'tokens-title';
const SOON_DAYS = 7;

/** Personal access tokens: create (sheet, then a one-time reveal), list and revoke. */
export function TokensSection({
  tokens,
  now,
  viewer,
  brandName,
  url,
}: {
  /** Null when the list could not be loaded. */
  tokens: TokenDto[] | null;
  now: string;
  viewer: boolean;
  brandName: string;
  url: string;
}) {
  const t = useTranslations('integrations.tokens');
  const root = useTranslations('integrations');
  const toast = useToast();
  const { locale, timeZone } = useHouseholdFormat();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedToken | null>(null);
  const [asking, setAsking] = useState<TokenDto | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = tokens ?? [];
  const removal = useRowRemoval(
    list.map((token) => token.id),
    TITLE_ID,
    asking !== null,
  );
  const nowDate = new Date(now);

  const isExpired = (token: TokenDto) =>
    token.expiresAt !== null && new Date(token.expiresAt) <= nowDate;

  async function revoke(token: TokenDto, viaDialog: boolean) {
    if (viaDialog) {
      setPending(true);
      setFailed(false);
    }
    const result = await revokeTokenAction(token.id).catch(() => null);
    if (viaDialog) setPending(false);
    if (result?.ok) {
      setAsking(null);
      toast.success(t(isExpired(token) ? 'removed' : 'revoked'));
      removal.collapse(token.id);
    } else if (viaDialog) {
      setFailed(true);
    } else {
      toast.error(t('removeError'));
    }
  }

  function expiryLine(token: TokenDto): { text: string; soon: boolean } {
    if (token.expiresAt === null) return { text: t('never'), soon: false };
    if (isExpired(token)) {
      return {
        text: t('expired', { date: zonedDate(token.expiresAt, locale, timeZone) }),
        soon: false,
      };
    }
    const days = dayDifference(
      todayIn(timeZone, new Date(token.expiresAt)),
      todayIn(timeZone, nowDate),
    );
    if (days <= SOON_DAYS) return { text: t('expiresSoon', { days }), soon: true };
    return {
      text: t('expires', { date: zonedDate(token.expiresAt, locale, timeZone) }),
      soon: false,
    };
  }

  const createButton = (
    <Button id="create-token-button" onClick={() => setCreating(true)} className="w-full sm:w-auto">
      {t('create')}
    </Button>
  );

  return (
    <>
      {tokens === null ? (
        <LoadError id={TITLE_ID} title={t('title')} help={t('help')} message={t('loadError')} />
      ) : tokens.length === 0 ? (
        <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
          <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} />
          <EmptyCard icon={<KeyRound className="size-6" />} action={createButton}>
            {t('empty')}
          </EmptyCard>
        </section>
      ) : (
        <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
          <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} action={createButton} />
          <ul
            data-testid="token-list"
            className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card"
          >
            {tokens.map((token) => {
              const expired = isExpired(token);
              const expiry = expiryLine(token);
              return (
                <CollapsibleRow key={token.id} collapsed={removal.collapsing.has(token.id)}>
                  <div
                    className={cn(
                      'flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap',
                      expired && 'text-muted-foreground',
                    )}
                  >
                    <KeyRound
                      className="size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 break-words text-base font-medium">
                          {token.name}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-caption',
                            expired
                              ? 'bg-surface-2 text-muted-foreground'
                              : token.scope === 'read_write'
                                ? 'bg-primary-soft text-primary-text'
                                : 'bg-surface-2 text-foreground',
                          )}
                        >
                          {expired ? t('expiredBadge') : t(`scope.${token.scope}`)}
                        </span>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <span className="sr-only">{t('prefixSr')} </span>
                        <span className={IDENT}>{token.prefix}…</span>
                        {' · '}
                        <span className={cn(expiry.soon && 'font-medium text-warning')}>
                          {expiry.text}
                        </span>
                        {' · '}
                        {token.lastUsedAt
                          ? t('lastUsed', {
                              when: relativeTime(
                                token.lastUsedAt,
                                nowDate,
                                locale,
                                root('justNow'),
                              ),
                            })
                          : t('neverUsed')}
                      </p>
                    </div>
                    <Button
                      ref={removal.buttonRef(token.id)}
                      variant="outline"
                      className="h-11 shrink-0 max-sm:w-full md:h-9 md:px-3 md:text-sm"
                      aria-label={t(expired ? 'removeNamed' : 'revokeNamed', { name: token.name })}
                      onClick={(event) => {
                        if (expired) void revoke(token, false);
                        else {
                          removal.opener.current = event.currentTarget;
                          setFailed(false);
                          setAsking(token);
                        }
                      }}
                    >
                      {expired ? t('remove') : t('revoke')}
                    </Button>
                  </div>
                </CollapsibleRow>
              );
            })}
          </ul>
        </section>
      )}

      <RevokeDialog
        open={asking !== null}
        title={t('revokeTitle', { name: asking?.name ?? '' })}
        description={t('revokeBody')}
        confirmLabel={t('revokeConfirm')}
        error={failed ? t('revokeError') : null}
        pending={pending}
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void revoke(asking, true)}
        onCloseAutoFocus={removal.onDialogClosed}
      />
      <CreateTokenSheet
        open={creating}
        onOpenChange={setCreating}
        viewer={viewer}
        onCreated={(created) => {
          setCreating(false);
          setRevealed(created);
        }}
      />
      <RevealTokenDialog
        name={revealed?.name ?? ''}
        token={revealed?.token ?? null}
        command={claudeCodeCommand(brandName, url, revealed?.token ?? '<token>')}
        onClose={() => {
          setRevealed(null);
          toast.success(t('created'));
        }}
      />
    </>
  );
}
