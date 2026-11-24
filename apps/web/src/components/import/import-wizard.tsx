'use client';

import { CircleCheck, FileUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition, type DragEvent } from 'react';
import type { ColumnMapping } from '@arfolio/services';
import {
  analyseImportAction,
  commitImportAction,
  extractPdfStatementAction,
  previewImportAction,
  type AnalysisDto,
  type CommitDto,
  type PreviewDto,
} from '@/server/actions/imports';
import type { AccountDto } from '@/server/serialize';
import { cn } from '@/lib/cn';
import { MAX_IMPORT_BYTES } from '@/lib/import-limits';
import { orConnectionLost } from '@/lib/import-request';
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
import { canReadPdf, PdfNotice, type ImportAiState } from './pdf-notice';

type Step = 'upload' | 'columns' | 'preview' | 'confirm' | 'result';
const NEW_ACCOUNT = '__new__';
const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.ofx,.qfx,.pdf';
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

/** A preview request for a CSV read from a PDF: every row comes back, so every row is seen. */
function allRows(form: FormData): FormData {
  form.set('allRows', 'true');
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
  ai,
}: {
  accounts: AccountDto[];
  initialAccountId?: string;
  currencies: Array<{ value: string; label: string }>;
  defaultCurrency: string;
  ai: ImportAiState;
}) {
  const t = useTranslations('import');
  const failure = useFailureMessage();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [accountId, setAccountId] = useState(
    initialAccounts.some((a) => a.id === initialAccountId) ? initialAccountId! : '',
  );
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [step, setStep] = useState<Step>('upload');
  // The file the steps after upload work on: the chosen file, or the CSV built from a PDF.
  const [file, setFile] = useState<File | null>(null);
  // A chosen PDF, kept until the user picks something else; it is only sent on request.
  const [pdf, setPdf] = useState<File | null>(null);
  // Set once the AI has read `pdfName` into `file`.
  const [source, setSource] = useState<{ pdfName: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisDto | null>(null);
  const [mapping, setMapping] = useState<EditableMapping | null>(null);
  const [preview, setPreview] = useState<PreviewDto | null>(null);
  // The mapping (as `JSON.stringify`) that `preview` was computed for.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
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
  // What an in-flight extraction compares against when it completes.
  const live = useRef({ pdf, accountId });
  live.current = { pdf, accountId };
  // The live preview's latest request; an answer to an older one is dropped. Reading another file
  // advances it too, so a late answer about the previous file cannot replace the new preview.
  const requestId = useRef(0);

  const isOfx = analysis?.file.kind === 'ofx';
  const steps = [
    { id: 'upload', label: t('steps.upload') },
    ...(isOfx ? [] : [{ id: 'columns', label: t('steps.columns') }]),
    { id: 'preview', label: t('steps.preview') },
    { id: 'confirm', label: t('steps.confirm') },
  ];
  const account = accounts.find((a) => a.id === accountId);
  const newRows = preview ? preview.stats.valid - preview.stats.duplicates : 0;

  /** Drops everything derived from the previous file, including a CSV read from a PDF. */
  function clearExtraction() {
    requestId.current += 1;
    setPreviewing(false);
    setSource(null);
    setFile(null);
    setAnalysis(null);
    setPreview(null);
    setPreviewKey(null);
    setMapping(null);
    setError(null);
  }

  function chooseAccount(id: string) {
    if (id !== accountId && source) clearExtraction();
    setAccountId(id);
  }

  function chooseFile(next: File | undefined) {
    if (pending) return;
    setFileError(null);
    if (!next) return;
    const lower = next.name.toLowerCase();
    if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) return setFileError(t('upload.badType'));
    if (next.size > MAX_IMPORT_BYTES) return setFileError(t('upload.tooLarge', { max: MAX_MB }));
    if (next.size === 0) return setFileError(t('upload.empty'));
    if (source) clearExtraction();
    setFormatName(next.name.replace(/\.[^.]+$/, ''));
    if (lower.endsWith('.pdf')) {
      setPdf(next);
      setFile(null);
    } else {
      setPdf(null);
      setFile(next);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (pending) return;
    chooseFile(e.dataTransfer.files[0]);
  }

  function analyse() {
    if (!file || !accountId) return;
    requestId.current += 1;
    setPreviewing(false);
    setError(null);
    startTransition(async () => {
      const res = await orConnectionLost(
        () => analyseImportAction(formData(file, accountId)),
        'connection_lost',
      );
      if (!res.ok) return setError(failure(res));
      const { data } = res;
      const initial = data.preview?.mapping ?? {
        headerRow: data.file.headerRow,
        dateFormat: 'auto' as const,
      };
      setAnalysis(data);
      setPreview(data.preview);
      setMapping(initial);
      setPreviewKey(data.preview ? JSON.stringify(initial) : null);
      setTab('all');
      setStep(data.file.kind === 'ofx' ? 'preview' : 'columns');
    });
  }

  function extractPdf() {
    if (!pdf || !accountId || !canReadPdf(ai)) return;
    requestId.current += 1;
    setPreviewing(false);
    setError(null);
    startTransition(async () => {
      const started = pdf;
      const startedAccount = accountId;
      const form = formData(pdf, accountId);
      form.set('confirmed', 'true');
      const extracted = await orConnectionLost(() => extractPdfStatementAction(form), 'ai_timeout');
      if (live.current.pdf !== started || live.current.accountId !== startedAccount) return;
      if (!extracted.ok) return setError(failure(extracted));
      const { csv, filename, mapping: found } = extracted.data;
      const generated = new File([csv], filename, { type: 'text/csv' });
      const res = await orConnectionLost(
        () => analyseImportAction(allRows(formData(generated, startedAccount, found))),
        'connection_lost',
      );
      // The person changed the file or account meanwhile: this result belongs to the old one.
      if (live.current.pdf !== started || live.current.accountId !== startedAccount) return;
      if (!res.ok) return setError(failure(res));
      const { data } = res;
      const initial = data.preview?.mapping ?? found;
      setFile(generated);
      setSource({ pdfName: started.name });
      setAnalysis(data);
      setPreview(data.preview);
      setMapping(initial);
      setPreviewKey(data.preview ? JSON.stringify(initial) : null);
      setTab('all');
      // The mapping came from the AI, so the preview is the first thing to check.
      setStep(data.preview ? 'preview' : 'columns');
    });
  }

  // Live preview while the user edits the mapping (debounced; stale answers are dropped).
  const refreshPreview = useCallback(
    (next: EditableMapping) => {
      if (!file || !accountId || !isComplete(next)) {
        setPreview(null);
        return;
      }
      const id = (requestId.current += 1);
      setPreviewing(true);
      const form = formData(file, accountId, next);
      void orConnectionLost(
        () => previewImportAction(source ? allRows(form) : form),
        'connection_lost',
      ).then((res) => {
        if (id !== requestId.current) return;
        setPreviewing(false);
        if (res.ok) {
          setPreview(res.data);
          setPreviewKey(JSON.stringify(next));
          setError(null);
        } else {
          setPreview(null);
          setError(failure(res));
        }
      });
    },
    [accountId, failure, file, source],
  );
  const mappingKey = JSON.stringify(mapping);
  // The preview shown is the one for the current mapping, and no refresh is waiting or running.
  const previewCurrent = preview !== null && previewKey === mappingKey && !previewing;
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

  /** Goes on with the extraction already kept, without a request. */
  function continueWithRead() {
    if (!source || !file || !analysis || !mapping) return;
    if (previewCurrent) return setStep('preview');
    // The mapping was edited after the last preview: the Columns step brings it up to date.
    first.current = false;
    setStep('columns');
  }

  function commit() {
    if (!file || !accountId || !previewCurrent) return;
    setError(null);
    startTransition(async () => {
      const res = await commitImportAction(
        formData(
          file,
          accountId,
          mapping && isComplete(mapping) && !isOfx ? mapping : null,
          saveFormat && !isOfx && !source ? formatName.trim() : undefined,
        ),
      );
      if (!res.ok) return setError(failure(res));
      setResult(res.data);
      setStep('result');
    });
  }

  function reset() {
    setPdf(null);
    clearExtraction();
    setResult(null);
    setUndone(false);
    setSaveFormat(false);
    setStep('upload');
  }

  const presetLabel = (key: string | null): string => {
    if (source) return t('presets.pdfAi');
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
                disabled={pending}
                value={accountId}
                onChange={(e) => {
                  if (e.target.value === NEW_ACCOUNT) setCreatingAccount(true);
                  else chooseAccount(e.target.value);
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
              if (!pending) setDragging(true);
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
            {pdf || file ? (
              <p className="text-base font-medium" data-testid="chosen-file">
                {(pdf ?? file)?.name}
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
              disabled={pending}
              aria-label={t('upload.chooseFile')}
              onChange={(e) => chooseFile(e.target.files?.[0])}
            />
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => fileInput.current?.click()}
            >
              {t('upload.chooseFile')}
            </Button>
            {fileError ? (
              <p role="alert" className="text-sm text-negative">
                {fileError}
              </p>
            ) : null}
          </div>

          {pdf ? <PdfNotice ai={ai} /> : null}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={pdf ? extractPdf : analyse}
              loading={pending}
              disabled={pdf ? !accountId || !canReadPdf(ai) : !file || !accountId}
            >
              {pending ? t('upload.reading') : pdf ? t('upload.pdf.send') : t('upload.continue')}
            </Button>
            {pdf && source && file && analysis && mapping ? (
              <Button
                variant="secondary"
                disabled={pending}
                onClick={continueWithRead}
                data-testid="pdf-continue"
              >
                {t('upload.pdf.continueRead')}
              </Button>
            ) : null}
          </div>
          {pdf ? (
            <p aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
              {pending ? t('upload.pdf.reading') : null}
            </p>
          ) : null}
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

          {source ? null : (
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
          )}

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep('upload')}>
              {t('back')}
            </Button>
            <Button
              disabled={!previewCurrent || (saveFormat && !source && formatName.trim() === '')}
              onClick={() => {
                if (previewCurrent) setStep('preview');
              }}
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
          {source ? (
            <Alert tone="info">
              <p data-testid="pdf-source-line">
                {t('preview.pdfSource', { name: source.pdfName })}
              </p>
            </Alert>
          ) : null}
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
            {!source && preview.stats.total > preview.rows.length ? (
              <p className="text-sm text-muted-foreground">
                {t('preview.firstRows', { shown: preview.rows.length, total: preview.stats.total })}
              </p>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setStep(isOfx ? 'upload' : 'columns');
              }}
            >
              {t('back')}
            </Button>
            <Button disabled={newRows === 0 || !previewCurrent} onClick={() => setStep('confirm')}>
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
              [t('confirm.file'), source?.pdfName ?? file.name],
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
            <Button loading={pending} disabled={!previewCurrent} onClick={commit}>
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
          chooseAccount(created.id);
        }}
      />
    </div>
  );
}
