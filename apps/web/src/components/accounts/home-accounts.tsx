import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { TYPE_ICONS } from '@/components/accounts/type-icons';
import { MoneyAmount } from '@/components/money-amount';
import { Card, CardHeader, IconTile } from '@/components/ui/card';
import { ConnectionsStrip } from '@/components/connections/connections-strip';
import type { HomeAccountItem } from '@/server/home-data';
import type { ConnectionDto } from '@/server/serialize';

/** Mini-cards shown before "Mais N contas". */
const MAX_CARDS = 8;

/**
 * "Contas e ligações": what is available to spend, one mini-card per account and how fresh the
 * connections are, side by side, because a balance means little without knowing when it was last
 * synced. The full account list is one tap away.
 */
export async function HomeAccounts({
  available,
  currency,
  otherCurrency,
  items,
  connections,
  now,
  locale,
  timeZone,
}: {
  available: number;
  currency: string;
  otherCurrency: number;
  items: HomeAccountItem[];
  connections: ConnectionDto[];
  now: Date;
  locale: string;
  timeZone: string;
}) {
  const [t, accountsT] = await Promise.all([getTranslations('home'), getTranslations('accounts')]);
  const shown = items.slice(0, MAX_CARDS);
  const hidden = items.length - shown.length;
  return (
    <Card
      as="section"
      data-testid="home-accounts"
      aria-labelledby="home-accounts-title"
      className="flex flex-col"
    >
      <CardHeader
        title={t('accounts.title')}
        titleId="home-accounts-title"
        link={{ href: '/accounts', label: t('accounts.see') }}
      />
      <div className="grid grid-cols-1 gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-muted-foreground">{t('available')}</span>
          <MoneyAmount minor={available} currency={currency} kind="balance" size="lg" />
          {otherCurrency > 0 ? (
            <span className="text-sm text-muted-foreground">
              {accountsT('otherCurrency', { count: otherCurrency })}
            </span>
          ) : null}
        </div>
        {shown.length > 0 ? (
          <ul
            aria-label={t('accounts.list')}
            className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] sm:gap-3"
          >
            {shown.map((a) => {
              const Icon = TYPE_ICONS[a.type];
              return (
                <li key={a.id} className="min-w-0">
                  <Link
                    href={`/accounts/${a.id}`}
                    className="flex min-h-14 items-center gap-3 rounded-md bg-surface-2 px-3 py-2.5 transition-[background-color,box-shadow] duration-[120ms] hover:bg-surface-3"
                  >
                    <IconTile
                      icon={Icon}
                      tone="neutral"
                      className="size-9 rounded-lg bg-surface [&>svg]:size-[18px]"
                    />
                    <span className="grid min-w-0 flex-1 grid-cols-1">
                      <span className="line-clamp-2 break-words text-sm font-medium" title={a.name}>
                        {a.name}
                      </span>
                      <span className="truncate text-label font-normal text-muted-foreground">
                        {a.institutionName ?? accountsT(`types.${a.type}`)}
                      </span>
                    </span>
                    <MoneyAmount
                      minor={a.balance}
                      currency={a.currency}
                      kind="balance"
                      size="sm"
                      className="shrink-0 font-semibold"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <p className="text-sm text-muted-foreground">{t('accounts.more', { count: hidden })}</p>
        ) : null}
        {connections.length > 0 ? (
          <ConnectionsStrip
            connections={connections}
            now={now}
            locale={locale}
            timeZone={timeZone}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('accounts.manualOnly')}</p>
        )}
      </div>
    </Card>
  );
}
