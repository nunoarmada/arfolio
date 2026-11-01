'use client';

import { CircleCheck, FileUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition, type DragEvent } from 'react';
import type { ColumnMapping } from '@arfolio/services';
import {
  analyseImportAction,
  commitImportAction,
  previewImportAction,
  type AnalysisDto,
  type CommitDto,
  type PreviewDto,
} from '@/server/actions/imports';
import type { AccountDto } from '@/server/serialize';
import { cn } from '@/lib/cn';
import { MAX_IMPORT_BYTES } from '@/lib/import-limits';
import { AccountFormSheet } from '../accounts/account-form-sheet';
import { UndoImportDialog } from '../accounts/undo-import-dialog';
import { Alert } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { useFailureMessage } from '../use-action-error';
import { ColumnMapper, isComplete, type EditableMapping } from './column-mapper';
import { ImportPreviewTable } from './import-preview-table';
import { ImportStepper } from './import-stepper';

type Step = 'upload' | 'columns' | 'preview' | 'confirm' | 'result';
const NEW_ACCOUNT = '__new__';
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.ofx,.qfx';
const EXTENSIONS = ACCEPT.split(',');
const PREVIEW_DEBOUNCE_MS = 400;
const MAX_MB = Math.round(MAX_IMPORT_BYTES / (1024 * 1024));

function formData(
  file: File,
  accountId: string,
  mapping?: ColumnMapping | null,
  presetName?: string,
): FormData {
  const form = new FormData();
  form.set('file', file);
  form.set('accountId', accountId);
  if (mapping) form.set('mapping', JSON.stringify(mapping));
  if (presetName) form.set('presetName', presetName);
  return form;
}

/**
 * Upload, map columns, preview, confirm, result. Back keeps what was entered. The file lives in
 * the browser until the final step; each preview sends it again, so nothing is stored on the
 * server before the user confirms.
 */
export function ImportWizard({
  accounts: initialAccounts,
  initialAccountId,
  currencies,
  defaultCurrency,
}: {
  accounts: AccountDto[];
  initialAccountId?: string;
  currencies: Array<{ value: string; label: string }>;
  defaultCurrency: string;
}) {
  const t = useTranslations('import');
  const failure = useFailureMessage();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [accountId, setAccountId] = useState(
    initialAccounts.some((a) => a.id === initialAccountId) ? initialAccountId! : '',
  );
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [mapping, setMapping] = useState<EditableMapping | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveFormat, setSaveFormat] = useState(false);
  const [formatName, setFormatName] = useState('');
  const [tab, setTab] = useState<'all' | 'new' | 'duplicate' | 'error'>('all');
  const [result, setResult] = useState<CommitDto | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);

  const isOfx = analysis?.file.kind === 'ofx';
  const steps = [
    { id: 'upload', label: t('steps.upload') },
    ...(isOfx ? [] : [{ id: 'columns', label: t('steps.columns') }]),
    { id: 'preview', label: t('steps.preview') },
    { id: 'confirm', label: t('steps.confirm') },
  ];
  const account = accounts.find((a) => a.id === accountId);
  const newRows = preview ? preview.stats.valid - preview.stats.duplicates : 0;

  function chooseFile(next: File | undefined) {
    setFileError(null);
    if (!next) return;
    const lower = next.name.toLowerCase();
    if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) return setFileError(t('upload.badType'));
    if (next.size > MAX_IMPORT_BYTES) return setFileError(t('upload.tooLarge', { max: MAX_MB }));
    if (next.size === 0) return setFileError(t('upload.empty'));
    setFile(next);
    setFormatName(next.name.replace(/\.[^.]+$/, ''));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    chooseFile(e.dataTransfer.files[0]);
  }

  function analyse() {
    if (!file || !accountId) return;
    setError(null);
    startTransition(async () => {
      const res = await analyseImportAction(formData(file, accountId));
      if (!res.ok) return setError(failure(res));
      const { data } = res;
      setAnalysis(data);
      setPreview(data.preview);
      setMapping(data.preview?.mapping ?? { headerRow: data.file.headerRow, dateFormat: 'auto' });
      setTab('all');
      setStep(data.file.kind === 'ofx' ? 'preview' : 'columns');
    });
  }

  // Live preview while the user edits the mapping (debounced; stale answers are dropped).
  const requestId = useRef(0);
  const refreshPreview = useCallback(
    (next: EditableMapping) => {
      if (!file || !accountId || !isComplete(next)) {
        setPreview(null);
        return;
      }
      const id = (requestId.current += 1);
      setPreviewing(true);
      void previewImportAction(formData(file, accountId, next)).then((res) => {
        if (id !== requestId.current) return;
        setPreviewing(false);
        if (res.ok) {
          setPreview(res.data);
          setError(null);
        } else {
          setPreview(null);
          setError(failure(res));
        }
      });
    },
    [accountId, failure, file],
  );
  const mappingKey = JSON.stringify(mapping);
  const first = useRef(true);
  useEffect(() => {
    if (step !== 'columns' || !mapping) return;
    // The analysis already previewed the detected mapping.
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = window.setTimeout(() => refreshPreview(mapping), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [mappingKey, step]);
  useEffect(() => {
    if (step === 'upload') first.current = true;
  }, [step]);

  function commit() {
    if (!file || !accountId) return;
    setError(null);
    startTransition(async () => {
      const res = await commitImportAction(
        formData(
          file,
          accountId,
          mapping && isComplete(mapping) && !isOfx ? mapping : null,
          saveFormat && !isOfx ? formatName.trim() : undefined,
        ),
      );
      if (!res.ok) return setError(failure(res));
      setResult(res.data);
      setStep('result');
    });
  }

  function reset() {
    setFile(null);
    setAnalysis(null);
    setMapping(null);
    setPreview(null);
    setResult(null);
    setUndone(false);
    setError(null);
    setSaveFormat(false);
    setStep('upload');
  }

  const presetLabel = (key: string | null): string => {
    if (!key) return t('presets.ofx');
    if (key.startsWith('household:')) return key.slice('household:'.length);
    return t(`presets.${key}`);
  };

  const shownRows = (preview?.rows ?? []).filter((r) =>
    tab === 'all'
      ? true
      : tab === 'new'
        ? r.status === 'ok' && !r.duplicate
        : tab === 'duplicate'
          ? r.duplicate === true
          : r.status === 'error',
  );

  return (
    <div className="grid grid-cols-1 gap-6">
      {step !== 'result' ? (
        <ImportStepper steps={steps} current={step} label={t('stepsLabel')} />
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      {step === 'upload' ? (
        <Card
          as="section"
          aria-labelledby="upload-title"
          pad="md"
          className="grid max-w-[640px] grid-cols-1 gap-5"
        >
          <h2 id="upload-title" className="text-heading">
            {t('upload.title')}
          </h2>
          <Field label={t('upload.account')}>
            {(p) => (
              <Select
                {...p}
                value={accountId}
                onChange={(e) => {
                  if (e.target.value === NEW_ACCOUNT) setCreatingAccount(true);
                  else setAccountId(e.target.value);
                }}
              >
                <option value="">{t('upload.chooseAccount')}</option>
                {accounts
                  .filter((a) => !a.archived)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                <option value={NEW_ACCOUNT}>{t('upload.newAccount')}</option>
              </Select>
            )}
          </Field>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'grid grid-cols-1 justify-items-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors duration-[120ms] md:p-8',
              dragging ? 'border-primary bg-primary-soft' : 'border-input bg-surface-2',
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text"
            >
              <FileUp className="size-5" />
            </span>
            {file ? (
              <p className="text-base font-medium" data-testid="chosen-file">
                {file.name}
              </p>
            ) : (
              <p className="text-base">{t('upload.drop')}</p>
            )}
            <p className="text-sm text-muted-foreground">{t('upload.accepts', { max: MAX_MB })}</p>
            <input
              ref={fileInput}
              id="import-file"
              type="file"
              accept={ACCEPT}
              className="sr-only"
              aria-label={t('upload.chooseFile')}
              onChange={(e) => chooseFile(e.target.files?.[0])}
            />
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              {t('upload.chooseFile')}
            </Button>
            {fileError ? (
              <p role="alert" className="text-sm text-negative">
                {fileError}
              </p>
            ) : null}
          </div>

          <Button
            onClick={analyse}
            loading={pending}
            disabled={!file || !accountId}
            className="justify-self-start"
          >
            {pending ? t('upload.reading') : t('upload.continue')}
          </Button>
        </Card>
      ) : null}

      {step === 'columns' && analysis && mapping ? (
        <Card
          as="section"
          aria-labelledby="columns-title"
          pad="md"
          className="grid max-w-[960px] grid-cols-1 gap-5"
        >
          <div className="grid grid-cols-1 gap-1">
            <h2 id="columns-title" className="text-heading">
              {t('columns.title')}
            </h2>
            {analysis.preview ? (
              <p className="text-sm text-positive" data-testid="detected">
                {t('columns.detected', { format: presetLabel(analysis.preview.presetKey) })}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">{t('columns.unknown')}</p>
            )}
          </div>
          <ColumnMapper file={analysis.file} mapping={mapping} onChange={setMapping} />

          <div className="grid grid-cols-1 gap-2" aria-live="polite">
            <h3 className="text-card-title">{t('columns.livePreview')}</h3>
            {previewing ? (
              <p className="text-sm text-muted-foreground">{t('columns.updating')}</p>
            ) : preview ? (
              <ImportPreviewTable rows={preview.rows.slice(0, 5)} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('columns.incomplete')}</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-1">
            <Checkbox
              label={t('columns.saveFormat')}
              checked={saveFormat}
              onChange={(e) => setSaveFormat(e.target.checked)}
            />
            {saveFormat ? (
              <Field label={t('columns.formatName')}>
                {(p) => (
                  <Input
                    {...p}
                    value={formatName}
                    maxLength={100}
                    onChange={(e) => setFormatName(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('upload')}>
              {t('back')}
            </Button>
            <Button
              disabled={!preview || previewing || (saveFormat && formatName.trim() === '')}
              onClick={() => setStep('preview')}
            >
              {t('continue')}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 'preview' && preview ? (
        <section aria-labelledby="preview-title" className="grid grid-cols-1 gap-5">
          <h2 id="preview-title" className="text-heading">
            {t('preview.title')}
          </h2>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['new', t('preview.new'), newRows],
              ['duplicate', t('preview.duplicates'), preview.stats.duplicates],
              ['skipped', t('preview.skippedRows'), preview.stats.skipped],
              ['error', t('preview.errors'), preview.stats.errors],
            ].map(([id, label, value]) => (
              <div key={id} className="rounded-lg bg-surface p-3 shadow-card md:p-4">
                <dt className="text-label text-muted-foreground">{label}</dt>
                <dd className="text-kpi tabular-nums" data-testid={`stat-${id}`}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {preview.stats.duplicates > 0 ? (
            <p className="text-sm text-muted-foreground">{t('preview.duplicatesNote')}</p>
          ) : null}
          {preview.stats.valid > 0 && newRows === 0 ? (
            <Alert tone="info">{t('preview.allDuplicates')}</Alert>
          ) : null}
          {preview.stats.valid === 0 ? <Alert tone="error">{t('preview.noRows')}</Alert> : null}

          <div className="grid grid-cols-1 gap-3">
            <div
              role="group"
              aria-label={t('preview.filter')}
              className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-surface-2 p-0.5"
            >
              {(['all', 'new', 'duplicate', 'error'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={tab === id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'min-h-11 rounded-md px-3 text-sm font-medium md:min-h-9 lg:pointer-fine:min-h-8',
                    tab === id
                      ? 'bg-surface text-foreground shadow-card'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`preview.tab.${id}`)}
                </button>
              ))}
            </div>
            {shownRows.length > 0 ? (
              <ImportPreviewTable rows={shownRows} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('preview.tabEmpty')}</p>
            )}
            {preview.stats.total > preview.rows.length ? (
              <p className="text-sm text-muted-foreground">
                {t('preview.firstRows', { shown: preview.rows.length, total: preview.stats.total })}
              </p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(isOfx ? 'upload' : 'columns')}>
              {t('back')}
            </Button>
            <Button disabled={newRows === 0} onClick={() => setStep('confirm')}>
              {t('continue')}
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'confirm' && preview && account && file ? (
        <Card
          as="section"
          aria-labelledby="confirm-title"
          pad="md"
          className="grid max-w-[640px] grid-cols-1 gap-5"
        >
          <h2 id="confirm-title" className="text-heading">
            {t('confirm.title')}
          </h2>
          <dl className="divide-y divide-border rounded-md bg-surface-2 px-4">
            {[
              [t('confirm.account'), account.name],
              [t('confirm.file'), file.name],
              [t('confirm.format'), presetLabel(preview.presetKey)],
              [
                t('confirm.ignored'),
                t('confirm.ignoredValue', {
                  duplicates: preview.stats.duplicates,
                  errors: preview.stats.errors,
                }),
              ],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-3">
                <dt className="text-sm text-muted-foreground">{k}</dt>
                <dd className="min-w-0 truncate text-right text-base">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="flex gap-2" aria-live="polite">
            <Button variant="secondary" disabled={pending} onClick={() => setStep('preview')}>
              {t('back')}
            </Button>
            <Button loading={pending} onClick={commit}>
              {pending ? t('confirm.running') : t('confirm.action', { count: newRows })}
            </Button>
          </div>
        </Card>
      ) : null}

      {step === 'result' && result ? (
        <Card
          as="section"
          aria-labelledby="result-title"
          pad="md"
          className="grid max-w-[640px] grid-cols-1 gap-4"
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-positive-soft text-positive"
            >
              <CircleCheck className="size-5" />
            </span>
            <h2 id="result-title" className="text-heading">
              {undone ? t('result.undone') : t('result.title', { count: result.inserted })}
            </h2>
          </div>
          {!undone ? (
            <p className="text-base text-muted-foreground" data-testid="result-summary">
              {t('result.summary', {
                duplicates: result.duplicates,
                skipped: result.skipped + result.errors,
                review: result.reviewCount,
              })}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!undone && result.reviewCount > 0 ? (
              <Link href="/transactions/review" className={buttonVariants({})}>
                {t('result.review')}
              </Link>
            ) : null}
            <Link
              href={`/transactions?account=${accountId}&period=all`}
              className={buttonVariants({
                variant: result.reviewCount > 0 && !undone ? 'outline' : 'default',
              })}
            >
              {t('result.view')}
            </Link>
            {!undone ? (
              <Button variant="outline" onClick={() => setUndoing(true)}>
                {t('result.undo')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={reset}>
              {t('result.another')}
            </Button>
          </div>
          <UndoImportDialog
            batchId={result.batchId}
            open={undoing}
            onOpenChange={setUndoing}
            onUndone={() => setUndone(true)}
          />
        </Card>
      ) : null}

      <AccountFormSheet
        open={creatingAccount}
        onOpenChange={setCreatingAccount}
        currencies={currencies}
        defaultCurrency={defaultCurrency}
        onSaved={(created) => {
          setAccounts((cur) => [...cur, created]);
          setAccountId(created.id);
        }}
      />
    </div>
  );
}
