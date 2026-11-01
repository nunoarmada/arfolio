import { listConnections } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { ConnectionsNav } from '@/components/connections/segmented-nav';
import { ConnectionsView, type ResultNotice } from '@/components/connections/connections-view';
import { bankingEnabled } from '@/server/connector-deps';
import { isResultCode } from '@/server/consent-callback';
import { toConnectionDto, type ConnectionDto } from '@/server/serialize';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('connections'))('title') };
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The result banner for `?result=&id=`: fixed codes only, details read from our own data. */
function resolveNotice(
  raw: Record<string, string | string[] | undefined>,
  connections: ConnectionDto[],
): ResultNotice | null {
  const code = first(raw.result);
  if (!isResultCode(code)) return null;
  const target = connections.find((c) => c.id === first(raw.id));
  if (code === 'linked') {
    return target ? { code, count: target.accounts.length } : null;
  }
  if (code === 'accounts_updated') {
    return target ? { code, name: target.displayName, count: target.accounts.length } : null;
  }
  if (code === 'key_updated') {
    return target ? { code, name: target.displayName } : null;
  }
  if (code === 'renewed') {
    return target ? { code, name: target.displayName, expiresAt: target.consentExpiresAt } : null;
  }
  return { code };
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, raw] = await Promise.all([requireMember(await headers()), searchParams]);
  const ctx = toServiceCtx(session);
  const now = new Date();
  const list = await listConnections(ctx, { now });
  const connections = list.map(toConnectionDto);
  return (
    <ConnectionsView
      connections={connections}
      nowIso={now.toISOString()}
      canWrite={session.role !== 'viewer'}
      bankingEnabled={await bankingEnabled()}
      canConfigure={session.role === 'owner'}
      notice={resolveNotice(raw, connections)}
      tabs={<ConnectionsNav current="connections" />}
    />
  );
}
