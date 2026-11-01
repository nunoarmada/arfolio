'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/cn';
import {
  buildLinks,
  initialRows,
  linkCount,
  linkableAccounts,
  validateRows,
  type LinkableAccount,
  type LinkOption,
  type LinkRow,
  type RowErrors,
} from '@/lib/link-accounts';
import { linkAccountsAction, type LinkAccountsResult } from '@/server/actions/connections';
import type { ConnectionLink } from '@arfolio/services';

type ServerError = Extract<LinkAccountsResult, { ok: false }>['error'];

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="text-sm text-negative">
      {children}
    </p>
  );
}

/** One provider account: what to do with it (new account, existing account, ignore). */
function LinkAccountRow({
  index,
  option,
  row,
  accounts,
  connectionId,
  accountTypes,
  errors,
  disabled,
  onChange,
}: {
  index: number;
  option: LinkOption;
  row: LinkRow;
  accounts: LinkableAccount[];
  connectionId: string;
  accountTypes: readonly string[];
  errors: RowErrors[string] | undefined;
  disabled: boolean;
  onChange: (patch: Partial<LinkRow>) => void;
}) {
  const t = useTranslations('linkAccounts');
  const types = useTranslations('accounts.typeOne');
  const uid = useId();
  const candidates = linkableAccounts(option, accounts, connectionId);
  const linkedAccount = accounts.find((a) => a.id === row.linkedTo);
  const locked = row.linkedTo !== null && !row.changing;
  const nameId = `link-${index}-name`;
  const accountId = `link-${index}-account`;

  const modes: Array<{ mode: LinkRow['mode']; label: string; off?: boolean }> = [
    { mode: 'create', label: t('optionCreate') },
    { mode: 'existing', label: t('optionExisting'), off: candidates.length === 0 },
    {
      mode: 'ignore',
      label: row.linkedTo === null ? t('optionIgnore') : t('optionStop'),
    },
  ];

  return (
    <fieldset
      disabled={disabled}
      className="grid grid-cols-1 min-w-0 gap-3 rounded-lg bg-surface shadow-card p-4 md:p-5"
    >
      <legend className="sr-only">{option.name}</legend>
      <div className="grid grid-cols-1 gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 text-base font-medium" aria-hidden="true">
            {option.name}
          </p>
          <span className="rounded-[6px] border bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {option.currency}
          </span>
        </div>
        {option.ibanLast4 ? (
          <p className="text-sm tabular-nums text-muted-foreground">
            <span aria-hidden="true">{t('ibanLast4', { last4: option.ibanLast4 })}</span>
            <span className="sr-only">{t('ibanSr', { last4: option.ibanLast4 })}</span>
          </p>
        ) : null}
      </div>

      {option.stableKey ? null : <Alert tone="warning">{t('unstable')}</Alert>}

      {locked ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-base">
            {t('linkedTo', { account: linkedAccount?.name ?? option.name })}
          </p>
          <Button variant="outline" onClick={() => onChange({ changing: true, mode: 'create' })}>
            {t('change')}
          </Button>
        </div>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-label={t('optionLabel', { name: option.name })}
            className="grid grid-cols-1 gap-2 md:grid-cols-3"
          >
            {modes.map((m) => (
              <label
                key={m.mode}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-base',
                  row.mode === m.mode
                    ? 'border-primary bg-primary-soft'
                    : 'border-input bg-surface',
                  m.off && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={`${uid}-mode`}
                  checked={row.mode === m.mode}
                  disabled={m.off}
                  onChange={() => onChange({ mode: m.mode })}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <span>{m.label}</span>
              </label>
            ))}
          </div>

          {row.mode === 'create' ? (
            <div className="grid grid-cols-1 content-start gap-3 md:grid-cols-2 md:items-start">
              <div className="grid grid-cols-1 gap-1.5">
                <label htmlFor={nameId} className="text-sm font-medium">
                  {t('name')}
                </label>
                <Input
                  id={nameId}
                  value={row.name}
                  maxLength={120}
                  aria-invalid={errors?.name ? true : undefined}
                  aria-describedby={errors?.name ? `${nameId}-error` : undefined}
                  onChange={(e) => onChange({ name: e.target.value })}
                />
                {errors?.name ? (
                  <FieldError id={`${nameId}-error`}>{t('errName')}</FieldError>
                ) : null}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                <label htmlFor={`link-${index}-type`} className="text-sm font-medium">
                  {t('type')}
                </label>
                <Select
                  id={`link-${index}-type`}
                  value={row.type}
                  onChange={(e) => onChange({ type: e.target.value })}
                >
                  {accountTypes.map((type) => (
                    <option key={type} value={type}>
                      {types(type)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}

          {row.mode === 'existing' ? (
            <div className="grid grid-cols-1 gap-1.5">
              <label htmlFor={accountId} className="text-sm font-medium">
                {t('existing')}
              </label>
              <Select
                id={accountId}
                value={row.accountId}
                aria-invalid={errors?.account ? true : undefined}
                aria-describedby={errors?.account ? `${accountId}-error` : undefined}
                onChange={(e) => onChange({ accountId: e.target.value })}
              >
                <option value="">{t('existingChoose')}</option>
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.ibanLast4 ? ` ···· ${a.ibanLast4}` : ''}
                  </option>
                ))}
              </Select>
              {errors?.account ? (
                <FieldError id={`${accountId}-error`}>
                  {errors.account === 'duplicate' ? t('errDuplicate') : t('errExistingRequired')}
                </FieldError>
              ) : null}
            </div>
          ) : null}

          {row.mode === 'ignore' ? (
            <p className="text-sm text-muted-foreground">
              {row.linkedTo === null ? t('ignoreHint') : t('stopHint')}
            </p>
          ) : null}
          {candidates.length === 0 && row.mode !== 'existing' ? (
            <p className="text-sm text-muted-foreground">
              {t('existingNone', { currency: option.currency })}
            </p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

/** The link step: one row per provider account, validated here first and again by the service. */
export function LinkAccountsForm({
  connectionId,
  options,
  accounts,
  accountTypes,
  defaultType,
  managing = false,
}: {
  connectionId: string;
  options: LinkOption[];
  accounts: LinkableAccount[];
  accountTypes: readonly string[];
  defaultType: string;
  /** Changing the accounts of a running connection (not the connect or renew flow). */
  managing?: boolean;
}) {
  const t = useTranslations('linkAccounts');
  const router = useRouter();
  const [rows, setRows] = useState<LinkRow[]>(() =>
    initialRows(options, accounts, connectionId, defaultType),
  );
  const [errors, setErrors] = useState<RowErrors>({});
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [pending, setPending] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const links = buildLinks(rows);
  const doneHref = `/connections?result=${managing ? 'accounts_updated' : 'linked'}&id=${connectionId}`;
  const toLink = linkCount(links);
  const anyLinked = rows.some((r) => r.linkedTo !== null && !r.changing);
  const nothing = links.length === 0 && !anyLinked;
  const failed = Object.keys(errors).length > 0 || serverError !== null;
  useEffect(() => {
    if (failed) summaryRef.current?.focus();
  }, [failed, errors, serverError]);

  const patch = (key: string, p: Partial<LinkRow>) =>
    setRows((cur) => cur.map((r) => (r.externalKey === key ? { ...r, ...p } : r)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setServerError(null);
    if (links.length === 0) {
      if (anyLinked) router.push(doneHref);
      return;
    }
    const found = validateRows(rows);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const result = await linkAccountsAction(connectionId, links as ConnectionLink[]);
      if (result.ok) {
        router.push(doneHref);
        return;
      }
      setServerError(result.error);
    } catch {
      setServerError('error');
    }
    setPending(false);
  }

  const serverText: Record<ServerError, string> = {
    already_linked: t('errAlreadyLinked'),
    currency: t('errCurrency'),
    revoked: t('errRevoked'),
    unknown_account: t('errUnknown'),
    invalid: t('errGeneric'),
    gone: t('errGeneric'),
    forbidden: t('viewerTitle'),
    error: t('errGeneric'),
  };

  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      className="grid grid-cols-1 max-w-[640px] gap-4"
    >
      {failed ? (
        <div ref={summaryRef} tabIndex={-1} className="rounded-lg outline-none">
          <Alert tone="error" title={serverError ? undefined : t('summaryTitle')}>
            {serverError ? (
              serverText[serverError]
            ) : (
              <ul className="grid grid-cols-1 list-disc gap-1 pl-4">
                {rows.flatMap((r, i) => {
                  const e = errors[r.externalKey];
                  if (!e) return [];
                  const target = e.name ? `link-${i}-name` : `link-${i}-account`;
                  const text = e.name
                    ? t('errName')
                    : e.account === 'duplicate'
                      ? t('errDuplicate')
                      : t('errExistingRequired');
                  return [
                    <li key={r.externalKey}>
                      <a href={`#${target}`} className="underline underline-offset-2">
                        {options[i]?.name}. {text}
                      </a>
                    </li>,
                  ];
                })}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      {options.map((o, i) => (
        <LinkAccountRow
          key={o.externalKey}
          index={i}
          option={o}
          row={rows[i]!}
          accounts={accounts}
          connectionId={connectionId}
          accountTypes={accountTypes}
          errors={errors[o.externalKey]}
          disabled={pending}
          onChange={(p) => patch(o.externalKey, p)}
        />
      ))}

      <div className="sticky bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom))] -mx-4 grid grid-cols-1 gap-2 border-t bg-background px-4 py-3 md:static md:mx-0 md:flex md:flex-wrap md:items-center md:border-0 md:px-0 md:py-0">
        {nothing ? (
          <p className="text-sm text-muted-foreground md:order-last md:w-full">{t('needOne')}</p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          loading={pending}
          aria-disabled={nothing || undefined}
          className={cn('max-md:w-full', nothing && 'cursor-not-allowed opacity-60')}
          onClick={(e) => {
            if (nothing) e.preventDefault();
          }}
        >
          {pending
            ? t('submitting')
            : toLink > 0
              ? t('submitCount', { count: toLink })
              : links.length > 0
                ? t('save')
                : t('submit')}
        </Button>
        <Link
          href="/connections"
          className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'max-md:w-full' })}
        >
          {t('later')}
        </Link>
      </div>
    </form>
  );
}
