'use client';

import {
  Banknote,
  CheckCircle2,
  ChevronDown,
  Lock,
  Mail,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { CopyButton } from '@/components/copy-button';
import { SettingsCard } from '@/components/settings/settings-card';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import type { ActionResult } from '@/server/actions/result';
import { removeServiceSetting, saveServiceSetting, testService } from '@/server/actions/services';
import type { FieldView, ServiceName, ServicesView } from '@/server/service-settings';

/** The id each setting has in the messages (a dotted key cannot be a message key). */
const MESSAGE_ID = {
  'anthropic.apiKey': 'apiKey',
  'ai.categorisationModel': 'categorisationModel',
  'ai.reportModel': 'reportModel',
  'ai.valuationModel': 'valuationModel',
  'ai.valuationPortals': 'valuationPortals',
  'enableBanking.appId': 'appId',
  'enableBanking.privateKey': 'privateKey',
  'enableBanking.apiUrl': 'apiUrl',
  'smtp.url': 'smtpUrl',
  'mail.from': 'mailFrom',
} as const;

type SettingKey = keyof typeof MESSAGE_ID;

const PORTAL_LISTS = ['property', 'vehicle', 'classifieds'] as const;
type PortalList = (typeof PORTAL_LISTS)[number];
type Portals = Record<PortalList, string[]>;

function parsePortals(json: string | undefined): Portals {
  const empty: Portals = { property: [], vehicle: [], classifieds: [] };
  if (!json) return empty;
  try {
    const parsed = JSON.parse(json) as Partial<Portals>;
    return Object.fromEntries(
      PORTAL_LISTS.map((l) => [l, Array.isArray(parsed[l]) ? parsed[l] : []]),
    ) as Portals;
  } catch {
    return empty;
  }
}

/** One host per line, trimmed and lower-cased; blank and repeated lines are dropped. */
const hostsFromText = (text: string): string[] => [
  ...new Set(
    text
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  ),
];

/** Remounts a row when the stored value changes, so its draft starts from what is now saved. */
const rowKey = (field: FieldView): string =>
  `${field.source}:${field.updatedAt ?? ''}:${field.value ?? ''}`;

type Feedback = { kind: 'invalid' | 'error'; text: string } | null;

/** Save/remove for one setting: pending state, a field-level error and the success toast. */
function useSettingActions(settingKey: SettingKey, onDone?: () => void) {
  const t = useTranslations('services');
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const id = MESSAGE_ID[settingKey];

  function report(result: ActionResult, success: string): void {
    if (result.ok) {
      setFeedback(null);
      toast.success(success);
      onDone?.();
      return;
    }
    if (result.code === 'validation') {
      setFeedback({ kind: 'invalid', text: t(`invalid.${id}`) });
    } else if (result.code === 'conflict') {
      setFeedback({ kind: 'error', text: t('errors.environment') });
    } else if (result.code === 'forbidden') {
      setFeedback({ kind: 'error', text: t('errors.forbidden') });
    } else if (result.code === 'reauth') {
      setFeedback({ kind: 'error', text: t('errors.reauth') });
    } else {
      setFeedback({ kind: 'error', text: t('errors.generic') });
    }
  }

  return {
    pending,
    feedback,
    clearFeedback: () => setFeedback(null),
    save(value: string, success = t('toast.saved')) {
      startTransition(async () => {
        report(await saveServiceSetting({ key: settingKey, value }), success);
      });
    },
    remove(success = t('toast.removed')) {
      startTransition(async () => {
        report(await removeServiceSetting({ key: settingKey }), success);
      });
    },
  };
}

function FeedbackAlert({ feedback }: { feedback: Feedback }) {
  return feedback?.kind === 'error' ? <Alert tone="error">{feedback.text}</Alert> : null;
}

/** "Set by environment": read-only, with where to change it. */
function EnvNote() {
  const t = useTranslations('services');
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">{t('status.env')}.</span>{' '}
        {t('status.envHelp')}
      </span>
    </p>
  );
}

function RowShell({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="grid grid-cols-1 gap-3 border-t border-border pt-5 outline-none first:border-t-0 first:pt-0"
    >
      {children}
    </div>
  );
}

/** Settings most installations never touch: collapsed, but open when one of them is set. */
function Advanced({ open, children }: { open: boolean; children: ReactNode }) {
  const t = useTranslations('services');
  return (
    <details className="group border-t border-border pt-3" open={open || undefined}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md text-sm font-medium [&::-webkit-details-marker]:hidden">
        {t('advanced')}
        <ChevronDown
          className="size-5 shrink-0 text-muted-foreground transition-transform duration-[180ms] group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </summary>
      <div className="grid grid-cols-1 gap-5 pt-3">{children}</div>
    </details>
  );
}

/**
 * A credential. It is never shown back: once stored the row says "Configured" and offers
 * Replace and Remove; the input only appears to enter a new value.
 */
function SecretRow({
  field,
  label,
  hint,
  multiline = false,
  removeWarning,
}: {
  field: FieldView;
  label: string;
  hint?: string;
  multiline?: boolean;
  removeWarning: string;
}) {
  const t = useTranslations('services');
  const format = useFormatter();
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const removing = useRef(false);
  const saved = useRef(false);
  const key = field.key as SettingKey;
  const done = () => {
    setEditing(false);
    setDraft('');
  };
  const actions = useSettingActions(key, done);
  const stored = field.configured && !field.unreadable;
  const showInput = editing || !stored;

  // After a save the input is replaced by the Replace/Remove row: keep focus in the row.
  useEffect(() => {
    if (saved.current && !showInput) {
      saved.current = false;
      rowRef.current?.focus();
    }
  }, [showInput]);

  if (field.source === 'env') {
    return (
      <RowShell>
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-positive" aria-hidden="true" />
          {t('status.configuredNoDate')}
        </p>
        <EnvNote />
      </RowShell>
    );
  }

  const date = field.updatedAt
    ? format.dateTime(new Date(field.updatedAt), { dateStyle: 'medium' })
    : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.trim() === '') return;
    saved.current = true;
    actions.save(draft);
  }

  return (
    <RowShell ref={rowRef}>
      {showInput ? (
        <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-3" noValidate>
          <Field
            label={label}
            hint={hint}
            error={actions.feedback?.kind === 'invalid' ? actions.feedback.text : undefined}
          >
            {(p) =>
              multiline ? (
                <Textarea
                  {...p}
                  value={draft}
                  rows={6}
                  autoFocus={editing}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="font-mono text-sm"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    actions.clearFeedback();
                  }}
                />
              ) : (
                <PasswordInput
                  {...p}
                  value={draft}
                  autoFocus={editing}
                  showLabel={t('showValue')}
                  hideLabel={t('hideValue')}
                  autoComplete="new-password"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    actions.clearFeedback();
                  }}
                />
              )
            }
          </Field>
          {field.unreadable ? (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t('status.unreadable')}</span>
            </p>
          ) : field.invalid ? (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t('status.invalid')}</span>
            </p>
          ) : null}
          <FeedbackAlert feedback={actions.feedback} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={actions.pending} disabled={draft.trim() === ''}>
              {t('actions.save')}
            </Button>
            {stored ? (
              <Button variant="ghost" onClick={done} disabled={actions.pending}>
                {t('actions.cancel')}
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p id={labelId} className="text-sm font-medium">
                {label}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 shrink-0 text-positive" aria-hidden="true" />
                {date ? t('status.configured', { date }) : t('status.configuredNoDate')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label={t('actions.replaceNamed', { name: label })}
                onClick={() => setEditing(true)}
              >
                {t('actions.replace')}
              </Button>
              <ConfirmDialog
                open={confirming}
                onOpenChange={setConfirming}
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('actions.removeNamed', { name: label })}
                  >
                    {t('actions.remove')}
                  </Button>
                }
                title={t('removeTitle', { name: label })}
                description={removeWarning}
                confirmLabel={t('actions.remove')}
                cancelLabel={t('actions.cancel')}
                pending={actions.pending}
                // The Remove button is gone once the value is removed: keep focus in the row.
                onCloseAutoFocus={(e) => {
                  if (!removing.current) return;
                  e.preventDefault();
                  removing.current = false;
                  rowRef.current?.focus();
                }}
                onConfirm={() => {
                  removing.current = true;
                  actions.remove();
                }}
              />
            </div>
          </div>
          <FeedbackAlert feedback={actions.feedback} />
        </>
      )}
    </RowShell>
  );
}

/** A setting that is safe to show: a text input with Save, and a way back to the default. */
function PlainRow({
  field,
  label,
  hint,
  resetLabel,
  removeWarning,
  inputMode,
}: {
  field: FieldView;
  label: string;
  hint?: string;
  resetLabel: string;
  /** When set, going back to the default asks first (the setting has no safe default). */
  removeWarning?: string;
  inputMode?: 'url' | 'email' | 'text';
}) {
  const t = useTranslations('services');
  const labelId = useId();
  const initial = field.value ?? '';
  const [draft, setDraft] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const actions = useSettingActions(field.key as SettingKey);
  const env = field.source === 'env';
  const dirty = draft.trim() !== initial.trim();
  const shownHint =
    field.source === 'default' && field.value
      ? [hint, t('defaultValue', { value: field.value })].filter(Boolean).join(' ')
      : hint;

  if (env) {
    return (
      <RowShell>
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        <code
          aria-labelledby={labelId}
          className="min-w-0 rounded-md bg-surface-2 px-3 py-2.5 font-mono text-sm [overflow-wrap:anywhere]"
        >
          {initial}
        </code>
        <EnvNote />
      </RowShell>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (dirty && draft.trim() !== '') actions.save(draft);
  }

  return (
    <RowShell>
      <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-3" noValidate>
        <Field
          label={label}
          hint={shownHint}
          error={actions.feedback?.kind === 'invalid' ? actions.feedback.text : undefined}
        >
          {(p) => (
            <Input
              {...p}
              value={draft}
              inputMode={inputMode}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
                actions.clearFeedback();
              }}
            />
          )}
        </Field>
        <FeedbackAlert feedback={actions.feedback} />
        <div className="flex flex-wrap items-center gap-2">
          {dirty || actions.pending ? (
            <Button type="submit" loading={actions.pending} disabled={draft.trim() === ''}>
              {t('actions.save')}
            </Button>
          ) : null}
          {field.source === 'db' && removeWarning ? (
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              trigger={
                <Button
                  variant="ghost"
                  aria-label={t('actions.removeNamed', { name: label })}
                  disabled={actions.pending}
                >
                  {resetLabel}
                </Button>
              }
              title={t('removeTitle', { name: label })}
              description={removeWarning}
              confirmLabel={t('actions.remove')}
              cancelLabel={t('actions.cancel')}
              pending={actions.pending}
              onConfirm={() => actions.remove()}
            />
          ) : field.source === 'db' ? (
            <Button
              variant="ghost"
              disabled={actions.pending}
              onClick={() => actions.remove(t('toast.reset'))}
            >
              {resetLabel}
            </Button>
          ) : null}
        </div>
      </form>
    </RowShell>
  );
}

/** The three lists of hosts the AI may search when it values an asset (one host per line). */
function PortalsRow({ field }: { field: FieldView }) {
  const t = useTranslations('services');
  const initial = parsePortals(field.value);
  const [draft, setDraft] = useState<Record<PortalList, string>>(
    () =>
      Object.fromEntries(PORTAL_LISTS.map((l) => [l, initial[l].join('\n')])) as Record<
        PortalList,
        string
      >,
  );
  const actions = useSettingActions('ai.valuationPortals');
  const dirty = PORTAL_LISTS.some(
    (l) => hostsFromText(draft[l]).join('\n') !== initial[l].join('\n'),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    actions.save(
      JSON.stringify(Object.fromEntries(PORTAL_LISTS.map((l) => [l, hostsFromText(draft[l])]))),
    );
  }

  return (
    <RowShell>
      <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-3" noValidate>
        <div className="grid grid-cols-1 gap-1">
          <p className="text-sm font-medium">{t('portals.title')}</p>
          <p className="text-sm text-muted-foreground">{t('portals.help')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {PORTAL_LISTS.map((list) => (
            <Field key={list} label={t(`portals.${list}`)}>
              {(p) => (
                <Textarea
                  {...p}
                  value={draft[list]}
                  rows={5}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="example.com"
                  className="font-mono text-sm"
                  aria-invalid={actions.feedback?.kind === 'invalid' ? true : undefined}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, [list]: e.target.value }));
                    actions.clearFeedback();
                  }}
                />
              )}
            </Field>
          ))}
        </div>
        {actions.feedback?.kind === 'invalid' ? (
          <p role="alert" className="text-sm text-negative">
            {actions.feedback.text}
          </p>
        ) : null}
        <FeedbackAlert feedback={actions.feedback} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={actions.pending} disabled={!dirty}>
            {t('actions.save')}
          </Button>
          {field.source === 'db' ? (
            <Button
              variant="ghost"
              disabled={actions.pending}
              onClick={() => actions.remove(t('toast.reset'))}
            >
              {t('actions.useDefaults')}
            </Button>
          ) : null}
        </div>
      </form>
    </RowShell>
  );
}

/** Tries the service with what is saved now and says what happened, in words. */
function TestRow({
  service,
  label,
  disabled,
  disabledHint,
}: {
  service: ServiceName;
  label: string;
  disabled: boolean;
  disabledHint: string;
}) {
  const t = useTranslations('services');
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  function run() {
    setOutcome(null);
    startTransition(async () => {
      const result = await testService({ service });
      if (!result.ok) {
        setOutcome({
          ok: false,
          text:
            result.code === 'forbidden'
              ? t('errors.forbidden')
              : result.code === 'reauth'
                ? t('errors.reauth')
                : t('test.failed'),
        });
        return;
      }
      const { ok, message } = result.data;
      const key = `test.${service}.${message}` as Parameters<typeof t>[0];
      setOutcome({ ok, text: t.has(key) ? t(key) : t(ok ? 'test.ok' : 'test.failed') });
    });
  }

  return (
    <RowShell>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" loading={pending} disabled={disabled} onClick={run}>
          {label}
        </Button>
        {disabled ? <p className="text-sm text-muted-foreground">{disabledHint}</p> : null}
      </div>
      {/* Always mounted, so a screen reader announces the result when it appears. */}
      <div aria-live="polite">
        {outcome ? (
          <Alert tone={outcome.ok ? 'success' : 'error'} role="none">
            {outcome.text}
          </Alert>
        ) : null}
      </div>
    </RowShell>
  );
}

export function ServicesForm({ view }: { view: ServicesView }) {
  const t = useTranslations('services');
  const f = view.fields;
  const has = (key: SettingKey) => f[key].configured && !f[key].unreadable;
  const touched = (keys: readonly SettingKey[]) => keys.some((k) => f[k].source !== 'default');
  const aiAdvanced = [
    'ai.categorisationModel',
    'ai.reportModel',
    'ai.valuationModel',
    'ai.valuationPortals',
  ] as const;

  return (
    <div className="grid grid-cols-1 gap-5">
      <SettingsCard
        id="ai"
        titleId="services-ai"
        title={t('ai.title')}
        description={t('ai.description')}
        icon={Sparkles}
      >
        <SecretRow
          field={f['anthropic.apiKey']}
          label={t('ai.apiKey')}
          hint={t('ai.apiKeyHint')}
          removeWarning={t('ai.removeWarning')}
        />
        <TestRow
          service="anthropic"
          label={t('ai.test')}
          disabled={!has('anthropic.apiKey')}
          disabledHint={t('test.needsSave.anthropic')}
        />
        {has('anthropic.apiKey') ? (
          <p className="text-sm text-muted-foreground">
            {t('ai.enableHint')}{' '}
            <Link
              href="/settings/household#ai"
              className="inline-flex min-h-11 items-center text-primary-text underline-offset-4 hover:underline"
            >
              {t('ai.enableLink')}
            </Link>
          </p>
        ) : null}
        <Advanced open={touched(aiAdvanced)}>
          <PlainRow
            key={rowKey(f['ai.categorisationModel'])}
            field={f['ai.categorisationModel']}
            label={t('ai.categorisationModel')}
            hint={t('ai.categorisationModelHint')}
            resetLabel={t('actions.useDefault')}
          />
          <PlainRow
            key={rowKey(f['ai.reportModel'])}
            field={f['ai.reportModel']}
            label={t('ai.reportModel')}
            hint={t('ai.reportModelHint')}
            resetLabel={t('actions.useDefault')}
          />
          <PlainRow
            key={rowKey(f['ai.valuationModel'])}
            field={f['ai.valuationModel']}
            label={t('ai.valuationModel')}
            hint={t('ai.valuationModelHint')}
            resetLabel={t('actions.useDefault')}
          />
          <PortalsRow key={rowKey(f['ai.valuationPortals'])} field={f['ai.valuationPortals']} />
        </Advanced>
      </SettingsCard>

      <SettingsCard
        id="bank"
        titleId="services-bank"
        title={t('bank.title')}
        description={t('bank.description')}
        icon={Banknote}
      >
        <RowShell>
          <div className="grid grid-cols-1 gap-1.5">
            <p id="services-callback-label" className="text-sm font-medium">
              {t('bank.callback')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code
                aria-labelledby="services-callback-label"
                className="min-w-0 flex-1 basis-64 [overflow-wrap:anywhere] rounded-md bg-surface-2 px-3 py-2.5 font-mono text-sm"
              >
                {view.callbackUrl}
              </code>
              <CopyButton text={view.callbackUrl} label={t('bank.copy')} />
            </div>
            <p className="text-sm text-muted-foreground">{t('bank.callbackHint')}</p>
          </div>
        </RowShell>
        <PlainRow
          key={rowKey(f['enableBanking.appId'])}
          field={f['enableBanking.appId']}
          label={t('bank.appId')}
          hint={t('bank.appIdHint')}
          resetLabel={t('actions.remove')}
          removeWarning={t('bank.removeWarning')}
        />
        <SecretRow
          field={f['enableBanking.privateKey']}
          label={t('bank.privateKey')}
          hint={t('bank.privateKeyHint')}
          multiline
          removeWarning={t('bank.removeWarning')}
        />
        <TestRow
          service="enableBanking"
          label={t('bank.test')}
          disabled={!has('enableBanking.appId') || !has('enableBanking.privateKey')}
          disabledHint={t('test.needsSave.enableBanking')}
        />
        <Advanced open={touched(['enableBanking.apiUrl'])}>
          <PlainRow
            key={rowKey(f['enableBanking.apiUrl'])}
            field={f['enableBanking.apiUrl']}
            label={t('bank.apiUrl')}
            hint={t('bank.apiUrlHint')}
            resetLabel={t('actions.useDefault')}
            inputMode="url"
          />
        </Advanced>
      </SettingsCard>

      <SettingsCard
        id="email"
        titleId="services-email"
        title={t('email.title')}
        description={t('email.description')}
        icon={Mail}
      >
        <SecretRow
          field={f['smtp.url']}
          label={t('email.smtpUrl')}
          hint={t('email.smtpUrlHint')}
          removeWarning={t('email.removeWarning')}
        />
        <PlainRow
          key={rowKey(f['mail.from'])}
          field={f['mail.from']}
          label={t('email.mailFrom')}
          hint={t('email.mailFromHint')}
          resetLabel={t('actions.remove')}
          removeWarning={t('email.removeWarning')}
          inputMode="email"
        />
        <TestRow
          service="smtp"
          label={t('email.test')}
          disabled={!has('smtp.url')}
          disabledHint={t('test.needsSave.smtp')}
        />
      </SettingsCard>
    </div>
  );
}
