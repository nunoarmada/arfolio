'use client';

import { ChevronLeft, FileUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type DragEvent, type ReactNode } from 'react';
import type { BudgetImportPreview, BudgetImportResult } from '@arfolio/services';
import { buildAccountLinks } from '@/lib/budget-import-links';
import { describeImportError, describeWarning } from '@/lib/budget-import-copy';
import { monthParam } from '@/lib/budget-period';
import { PageContainer } from '@/components/page-container';
import { cn } from '@/lib/cn';
import { MAX_IMPORT_BYTES } from '@/lib/import-limits';
import {
  commitBudgetImportAction,
  previewBudgetImportAction,
} from '@/server/actions/budget-import';
import type { ActionFailure } from '@/server/actions/result';
import { ImportStepper } from '../../import/import-stepper';
import { useHouseholdFormat } from '../../household-format';
import { Alert } from '../../ui/alert';
import { ConfirmDialog } from '../../ui/alert-dialog';
import { Button, buttonVariants } from '../../ui/button';
import { Card } from '../../ui/card';
import { Checkbox } from '../../ui/checkbox';
import { useFailureMessage } from '../../use-action-error';
import { GoalsOptions, NetWorthOptions, sheetRows, type LinkChoices } from './import-net-worth';
import { ImportReview, useSectionLabel } from './import-review';
import { useFormatMoney } from '@/components/privacy';

type Step = 'upload' | 'review' | 'options' | 'done';
const MAX_MB = Math.round(MAX_IMPORT_BYTES / (1024 * 1024));

/** A problem to show: a message key under `budgetImport` and what to offer next. */
interface Problem {
  text: string;
  next?: 'upload' | 'budget' | 'retry';
}

/**
 * Upload the spreadsheet, review what it holds, choose what to create, import. The file is read
 * on the server once; the preview it returns is what the commit applies, all or nothing.
 */
export function BudgetImportWizard({
  accountNames,
  linkableAccounts,
  groupNames,
  budgetNames,
  hubConfigured,
}: {
  accountNames: Array<[string, string]>;
  /** Accounts a Património row can be linked to, per side, and who counts each one now. */
  linkableAccounts: LinkChoices;
  groupNames: Array<[string, string]>;
  /** Budget id -> name, to name the one a replacement would overwrite. */
  budgetNames: Array<[string, string]>;
  hubConfigured: boolean;
}) {
  const t = useTranslations('budgetImport');
  const common = useTranslations('common');
  const failure = useFailureMessage();
  const section = useSectionLabel();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<BudgetImportPreview | null>(null);
  const [result, setResult] = useState<BudgetImportResult | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [createAccounts, setCreateAccounts] = useState(true);
  const [createGroups, setCreateGroups] = useState(true);
  const [replace, setReplace] = useState(false);
  const [raced, setRaced] = useState(false);
  const [includeNetWorth, setIncludeNetWorth] = useState(true);
  const [includeGoals, setIncludeGoals] = useState(true);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const doneNote = useRef<HTMLSpanElement>(null);
  const firstRender = useRef(true);

  // Each step has a heading; moving to it tells a screen reader where it is.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    (step === 'done' ? doneNote.current : heading.current)?.focus();
  }, [step]);

  const accountMap = new Map(accountNames);
  const groupMap = new Map(groupNames);
  const budgetMap = new Map(budgetNames);
  const steps = [
    { id: 'upload', label: t('steps.upload') },
    { id: 'review', label: t('steps.review') },
    { id: 'options', label: t('steps.options') },
    { id: 'done', label: t('steps.done') },
  ];

  function describeFailure(f: ActionFailure): string {
    if (f.code === 'validation' && f.detail) {
      const d = describeImportError(f.detail.code, f.detail.params, section);
      return t(d.key, d.values);
    }
    return failure(f);
  }

  function chooseFile(next: File | undefined) {
    setFileError(null);
    setProblem(null);
    if (!next) return;
    if (!next.name.toLowerCase().endsWith('.xlsx')) return setFileError(t('upload.badType'));
    if (next.size > MAX_IMPORT_BYTES) return setFileError(t('upload.tooLarge', { max: MAX_MB }));
    if (next.size === 0) return setFileError(t('upload.empty'));
    setFile(next);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    chooseFile(e.dataTransfer.files[0]);
  }

  function read() {
    if (!file) return;
    setProblem(null);
    const form = new FormData();
    form.set('file', file);
    startTransition(async () => {
      const res = await previewBudgetImportAction(form);
      if (!res.ok) return setProblem({ text: describeFailure(res) });
      setPreview(res.data);
      setCreateAccounts(true);
      setCreateGroups(true);
      setReplace(false);
      setRaced(false);
      setIncludeNetWorth(true);
      setIncludeGoals(true);
      setLinks({});
      setStep('review');
    });
  }

  function commit() {
    if (!preview) return;
    setProblem(null);
    startTransition(async () => {
      // Only what the file has is switched; links are sent only where they differ from the
      // importer's own default, and not at all when Património is left out.
      const accountLinks =
        preview.patrimonio && includeNetWorth
          ? buildAccountLinks(sheetRows(preview.patrimonio), links)
          : {};
      const res = await commitBudgetImportAction(preview.token, {
        createMissingAccounts: createAccounts,
        createMissingGroups: createGroups,
        replaceExisting: replace,
        ...(preview.patrimonio ? { includePatrimonio: includeNetWorth } : {}),
        ...(preview.goals ? { includeObjetivos: includeGoals } : {}),
        ...(Object.keys(accountLinks).length > 0 ? { accountLinks } : {}),
      });
      if (!res.ok) {
        const exists =
          (res.code === 'validation' && res.detail?.code === 'budget_exists') ||
          (res.code === 'conflict' && res.conflict === 'budget_exists');
        if (exists) {
          setRaced(true);
          return setProblem({ text: t('options.raced') });
        }
        if (res.code === 'validation' && res.detail?.code === 'preview_expired') {
          return setProblem({ text: t('options.expired'), next: 'upload' });
        }
        if (res.code === 'validation' && res.detail?.code === 'preview_used') {
          return setProblem({ text: t('options.used'), next: 'budget' });
        }
        // Retrying cannot help with these two: say why, and offer a way out only when there is one.
        if (res.code === 'validation' && res.detail?.code === 'emergency_fund_exists') {
          return setProblem({
            text: `${describeFailure(res)} ${t('options.nothingImported')}`,
            next: 'upload',
          });
        }
        if (res.code === 'validation' && res.fields.includes('accountLinks')) {
          return setProblem({ text: t('options.linkFailed') });
        }
        return setProblem({
          text: `${describeFailure(res)} ${t('options.nothingImported')}`,
          next: 'retry',
        });
      }
      setResult(res.data);
      setStep('done');
    });
  }

  function restart() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setProblem(null);
    setFileError(null);
    setStep('upload');
  }

  const hasNetWorthOptions =
    (preview?.patrimonio?.assets.length ?? 0) + (preview?.patrimonio?.liabilities.length ?? 0) > 0;
  const hasGoalsOptions = (preview?.goals?.length ?? 0) > 0;
  const newAccounts = preview?.accounts.filter((a) => a.match === null).length ?? 0;
  const newGroups = preview?.groups.filter((g) => g.match === null).length ?? 0;
  const mustReplace = preview?.existingBudgetId != null || raced;
  const hasBaseOptions = newAccounts > 0 || newGroups > 0 || mustReplace;
  const nothingToChoose = !hasBaseOptions && !hasNetWorthOptions && !hasGoalsOptions;
  const existingName = preview?.existingBudgetId
    ? (budgetMap.get(preview.existingBudgetId) ?? t('options.existingFallback'))
    : t('options.existingFallback');
  const blocked = mustReplace && !replace;
  const expires = preview
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
        new Date(preview.expiresAt),
      )
    : '';

  /** "2 novos, 1 atualizado" for a count of created and updated records; empty when none. */
  const created = (made: number, updated: number): string =>
    [
      made > 0 ? t('done.countNew', { count: made }) : '',
      updated > 0 ? t('done.countUpdated', { count: updated }) : '',
    ]
      .filter(Boolean)
      .join(', ');
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const doneWarnings = result?.warnings.map((w) => describeWarning(w, money, section)) ?? [];

  const guarded = preview !== null && step !== 'done';
  /** Leaving mid-import asks first; before a file is read, or once done, it is a plain link. */
  const backTo = (className: string, content: ReactNode) =>
    guarded ? (
      <ConfirmDialog
        trigger={
          <button type="button" aria-label={common('back')} className={className}>
            {content}
          </button>
        }
        title={t('leaveTitle')}
        description={t('leaveBody')}
        confirmLabel={t('leaveConfirm')}
        cancelLabel={common('cancel')}
        onConfirm={() => router.push('/budget')}
      />
    ) : (
      <Link href="/budget" aria-label={common('back')} className={className}>
        {content}
      </Link>
    );

  return (
    <PageContainer width="full">
      <div className="grid grid-cols-1 gap-6">
        <header>
          {backTo(
            'mb-4 hidden min-h-11 items-center gap-1 rounded-md pr-3 text-base text-muted-foreground hover:text-foreground md:inline-flex',
            <>
              <ChevronLeft className="size-5" aria-hidden="true" />
              {common('back')}
            </>,
          )}
          <div className="flex items-start gap-1">
            {backTo(
              '-ml-3 -mt-1 flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2 md:hidden',
              <ChevronLeft className="size-6" aria-hidden="true" />,
            )}
            <h1 className="text-title min-w-0 flex-1 break-words">{t('title')}</h1>
          </div>
        </header>

        <ImportStepper steps={steps} current={step} label={t('stepsLabel')} />

        {step === 'upload' ? (
          <Card
            as="section"
            aria-labelledby="upload-title"
            pad="md"
            className="grid max-w-[640px] grid-cols-1 gap-5"
          >
            <h2 id="upload-title" ref={heading} tabIndex={-1} className="text-heading outline-none">
              {t('upload.title')}
            </h2>
            <p className="max-w-[68ch] text-base text-muted-foreground">{t('upload.intro')}</p>

            <section
              aria-labelledby="how-export"
              className="grid grid-cols-1 gap-2 rounded-md bg-surface-2 p-4"
            >
              <h3 id="how-export" className="text-base font-semibold">
                {t('upload.howTitle')}
              </h3>
              <ol className="grid grid-cols-1 list-decimal gap-1 pl-5 text-base">
                <li>{t('upload.howSheets')}</li>
                <li>{t('upload.howExcel')}</li>
              </ol>
              <p className="text-sm text-muted-foreground">{t('upload.needs')}</p>
            </section>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'grid grid-cols-1 justify-items-center gap-3 rounded-lg border-2 border-dashed p-6 text-center',
                dragging ? 'border-primary bg-primary-soft' : 'border-input bg-surface-2/50',
              )}
            >
              <FileUp className="size-8 text-muted-foreground" aria-hidden="true" />
              {file ? (
                <p className="break-all text-base font-medium" data-testid="chosen-file">
                  {file.name}
                </p>
              ) : (
                <p className="text-base">{t('upload.drop')}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {t('upload.accepts', { max: MAX_MB })}
              </p>
              <input
                ref={fileInput}
                id="budget-import-file"
                type="file"
                accept=".xlsx"
                className="sr-only"
                aria-label={t('upload.chooseFile')}
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
              <Button variant="outline" onClick={() => fileInput.current?.click()}>
                {t('upload.chooseFile')}
              </Button>
              {fileError ? (
                <p role="alert" className="text-sm text-negative">
                  {fileError}
                </p>
              ) : null}
            </div>

            {problem ? <Alert tone="error">{problem.text}</Alert> : null}

            <div aria-live="polite" className="flex flex-wrap items-center gap-3">
              <Button
                onClick={read}
                loading={pending}
                disabled={!file}
                className="justify-self-start"
              >
                {pending ? t('upload.reading') : t('upload.read')}
              </Button>
              {pending ? <span className="sr-only">{t('upload.readingLive')}</span> : null}
            </div>
          </Card>
        ) : null}

        {step === 'review' && preview ? (
          <section aria-labelledby="review-title" className="grid grid-cols-1 gap-5">
            <h2 id="review-title" ref={heading} tabIndex={-1} className="text-heading outline-none">
              {t('review.title')}
            </h2>
            <ImportReview preview={preview} accountNames={accountMap} groupNames={groupMap} />
            <div className="grid grid-cols-1 gap-2">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setStep('options')}>{common('continue')}</Button>
                <Button variant="ghost" onClick={restart}>
                  {t('review.another')}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {t('review.validUntil', { time: expires })}
              </p>
            </div>
          </section>
        ) : null}

        {step === 'options' && preview ? (
          <Card
            as="section"
            aria-labelledby="options-title"
            aria-busy={pending || undefined}
            pad="md"
            className="grid max-w-[640px] grid-cols-1 gap-5"
          >
            <h2
              id="options-title"
              ref={heading}
              tabIndex={-1}
              className="text-heading outline-none"
            >
              {t('options.title')}
            </h2>
            {problem ? (
              <Alert
                tone="error"
                action={
                  problem.next === 'upload' ? (
                    <Button variant="outline" onClick={restart}>
                      {t('options.uploadAgain')}
                    </Button>
                  ) : problem.next === 'budget' ? (
                    <Link href="/budget" className={buttonVariants({ variant: 'outline' })}>
                      {t('done.view')}
                    </Link>
                  ) : problem.next === 'retry' ? (
                    <Button variant="outline" onClick={commit}>
                      {t('options.retry')}
                    </Button>
                  ) : undefined
                }
              >
                {problem.text}
              </Alert>
            ) : null}
            {hasBaseOptions || nothingToChoose ? (
              <fieldset className="grid grid-cols-1 gap-1 rounded-md bg-surface-2 px-4 py-2">
                <legend className="sr-only">{t('options.legend')}</legend>
                {newAccounts > 0 ? (
                  <Checkbox
                    label={t('options.createAccounts', { count: newAccounts })}
                    hint={createAccounts ? undefined : t('options.accountsOff')}
                    checked={createAccounts}
                    disabled={pending}
                    onChange={(e) => setCreateAccounts(e.target.checked)}
                  />
                ) : null}
                {newGroups > 0 ? (
                  <Checkbox
                    label={t('options.createGroups', { count: newGroups })}
                    hint={createGroups ? undefined : t('options.groupsOff')}
                    checked={createGroups}
                    disabled={pending}
                    onChange={(e) => setCreateGroups(e.target.checked)}
                  />
                ) : null}
                {mustReplace ? (
                  <Checkbox
                    label={t('options.replace', { name: existingName })}
                    hint={t('options.replaceHint')}
                    checked={replace}
                    disabled={pending}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                ) : null}
                {nothingToChoose ? (
                  <p className="py-2 text-base text-muted-foreground">
                    {t('options.nothingToChoose')}
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {preview.patrimonio && hasNetWorthOptions ? (
              <NetWorthOptions
                preview={preview.patrimonio}
                include={includeNetWorth}
                onInclude={setIncludeNetWorth}
                selection={links}
                onSelect={(key, accountId) =>
                  setLinks((current) => ({ ...current, [key]: accountId }))
                }
                accounts={linkableAccounts}
                accountNames={accountMap}
                disabled={pending}
              />
            ) : null}
            {preview.goals && hasGoalsOptions ? (
              <GoalsOptions
                count={preview.goals.length}
                include={includeGoals}
                onInclude={setIncludeGoals}
                disabled={pending}
              />
            ) : null}

            <div className="grid grid-cols-1 gap-2" aria-live="polite">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={pending} onClick={() => setStep('review')}>
                  {common('back')}
                </Button>
                {replace ? (
                  <ConfirmDialog
                    trigger={
                      <Button loading={pending}>
                        {pending ? t('options.running') : t('options.run')}
                      </Button>
                    }
                    title={t('options.replaceTitle', { name: existingName })}
                    description={t('options.replaceHint')}
                    confirmLabel={t('options.replaceConfirm')}
                    cancelLabel={common('cancel')}
                    onConfirm={commit}
                  />
                ) : (
                  <Button
                    loading={pending}
                    aria-disabled={blocked || undefined}
                    aria-describedby={blocked ? 'import-blocked' : undefined}
                    className={cn(blocked && 'opacity-60')}
                    onClick={() => {
                      if (!blocked) commit();
                    }}
                  >
                    {pending ? t('options.running') : t('options.run')}
                  </Button>
                )}
              </div>
              {blocked ? (
                <p id="import-blocked" className="text-sm text-muted-foreground">
                  {t('options.blocked')}
                </p>
              ) : null}
              {pending ? <span className="sr-only">{t('options.runningLive')}</span> : null}
            </div>
          </Card>
        ) : null}

        {step === 'done' && result && preview ? (
          <Card
            as="section"
            aria-labelledby="done-title"
            pad="md"
            className="grid max-w-[640px] grid-cols-1 gap-4"
          >
            <h2 id="done-title" className="sr-only">
              {t('done.title')}
            </h2>
            <Alert tone="success">
              <span ref={doneNote} tabIndex={-1} className="font-semibold outline-none">
                {t('done.imported')}
              </span>
            </Alert>
            <dl className="divide-y divide-border rounded-md bg-surface-2 px-4">
              {(
                [
                  [t('done.lines'), String(result.linesImported), true],
                  [t('done.accounts'), String(result.accountsCreated), false],
                  [t('done.groups'), String(result.groupsCreated), false],
                  [t('done.categories'), String(result.categoriesCreated), false],
                  [t('done.subscriptions'), String(result.subscriptionsImported), false],
                  [t('done.skipped'), String(result.subscriptionsSkipped), false],
                  [t('done.assets'), created(result.assetsCreated, result.assetsUpdated), false],
                  [
                    t('done.liabilities'),
                    created(result.liabilitiesCreated, result.liabilitiesUpdated),
                    false,
                  ],
                  [t('done.goals'), created(result.goalsCreated, result.goalsUpdated), false],
                ] as const
              )
                .filter(([, value, always]) => always || (value !== '' && value !== '0'))
                .map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4 py-3">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="text-right text-base font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
            </dl>
            {doneWarnings.length > 0 ? (
              <Alert tone="warning" title={t('done.warnings', { count: doneWarnings.length })}>
                <ul className="grid grid-cols-1 list-disc gap-1 pl-4">
                  {doneWarnings.map((w, i) => (
                    <li key={i}>{t(w.key, w.values)}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {result.replaced ? <p className="text-base">{t('done.replaced')}</p> : null}
            {result.assetsCreated +
              result.assetsUpdated +
              result.liabilitiesCreated +
              result.liabilitiesUpdated >
            0 ? (
              <p className="text-base text-muted-foreground">
                {t('done.snapshotsRefreshed', { count: result.snapshotsRefreshed })}
              </p>
            ) : null}
            {result.categoriesCreated > 0 ? (
              <p className="text-base text-muted-foreground">{t('done.categoriesNote')}</p>
            ) : null}
            {!hubConfigured ? (
              <p className="text-base">
                {t('done.hubNote')}{' '}
                <Link
                  href="/settings/budget#hub"
                  className="text-primary underline underline-offset-4"
                >
                  {t('done.hubLink')}
                </Link>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/budget?month=${monthParam(preview.startMonth)}`}
                className={buttonVariants({})}
              >
                {t('done.view')}
              </Link>
              {result.subscriptionsImported > 0 ? (
                <Link
                  href="/budget/subscriptions"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('done.review')}
                </Link>
              ) : null}
              {result.assetsCreated +
                result.assetsUpdated +
                result.liabilitiesCreated +
                result.liabilitiesUpdated >
              0 ? (
                <Link href="/net-worth" className={buttonVariants({ variant: 'outline' })}>
                  {t('done.viewNetWorth')}
                </Link>
              ) : null}
              {result.goalsCreated + result.goalsUpdated > 0 ? (
                <Link href="/net-worth/goals" className={buttonVariants({ variant: 'outline' })}>
                  {t('done.viewGoals')}
                </Link>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </PageContainer>
  );
}
