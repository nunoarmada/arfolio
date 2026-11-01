'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import type { SaleCandidate } from '@arfolio/services';
import { parsePlanned } from '@/lib/amount-input';
import { isIsoDate } from '@/lib/dates';
import { formatDayYear } from '@/lib/net-worth-format';
import { disposeAssetAction } from '@/server/actions/net-worth';
import type { LinkedLiabilityDto } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Field, Input } from '../ui/field';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { SaleTransactionPicker, useSaleCandidates } from './sale-transaction-picker';
import { useFormatMoney } from '@/components/privacy';

type Mode = 'sold' | 'written_off';
type Entry = 'link' | 'hand';

interface CreditChoice {
  checked: boolean;
  /** Typed by the user; null while the date still follows the sale date. */
  date: string | null;
}

interface Errors {
  date?: string;
  amount?: string;
  pick?: string;
  credits: Record<string, string>;
}

/**
 * "Registar venda" and "Abater ativo": one sheet for both. A sale is taken from a transaction or
 * typed by hand; the credits linked to the asset can end with it, each on its own date.
 */
export function DisposeAssetSheet({
  mode,
  open,
  onOpenChange,
  asset,
  credits,
  today,
  onDone,
}: {
  mode: Mode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: { id: string; name: string; currency: string; accountName: string | null };
  /** Unsettled linked liabilities, largest balance first. */
  credits: LinkedLiabilityDto[];
  today: string;
  /** Called once the change is saved, before the page refreshes. */
  onDone: () => void;
}) {
  const t = useTranslations('disposal');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const formId = useId();
  const selling = mode === 'sold';
  const candidates = useSaleCandidates(asset.id, open && selling);

  const [entry, setEntry] = useState<Entry>(selling ? 'link' : 'hand');
  const touched = useRef(false);
  const [selected, setSelected] = useState<SaleCandidate | null>(null);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [choices, setChoices] = useState<Record<string, CreditChoice>>({});
  const [errors, setErrors] = useState<Errors>({ credits: {} });
  const [pickError, setPickError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const focusDate = useRef(false);

  // A sheet that opens again starts clean. Depends on `open` only: `credits` and `today` change
  // identity on every refresh, which must not wipe what the user is typing in an open sheet.
  useEffect(() => {
    if (!open) return;
    setEntry(selling ? 'link' : 'hand');
    touched.current = false;
    saved.current = false;
    setSelected(null);
    setDate(today);
    setAmount('');
    setChoices(Object.fromEntries(credits.map((c) => [c.id, { checked: true, date: null }])));
    setErrors({ credits: {} });
    setPickError(null);
    setFormError(null);
  }, [open]);

  // With no transaction to link, start on "Registar à mão" (unless the user already chose).
  useEffect(() => {
    if (selling && candidates.initial === 'empty' && !touched.current) setEntry('hand');
  }, [selling, candidates.initial]);

  useEffect(() => {
    if (entry === 'hand' && focusDate.current) {
      focusDate.current = false;
      dateRef.current?.focus();
    }
  }, [entry]);

  const chooseEntry = (next: Entry, thenFocusDate = false) => {
    touched.current = true;
    focusDate.current = thenFocusDate;
    setEntry(next);
    setPickError(null);
  };

  /** The day the asset leaves: the transaction's, or the typed date. */
  const saleDate = selling && entry === 'link' ? (selected?.bookingDate ?? '') : date;
  const effective = (id: string) => choices[id]?.date ?? saleDate;
  const ticked = credits.filter((c) => choices[c.id]?.checked);

  const dateProblem = (value: string): string | undefined => {
    if (!value) return t('dateRequired');
    if (!isIsoDate(value)) return t('dateInvalid');
    if (value > today) return t('dateFuture');
    return undefined;
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found: Errors = { credits: {} };
    let pick: string | null = null;
    let minor = 0;
    if (selling && entry === 'link') {
      if (!selected) pick = t('pickRequired');
    } else {
      found.date = dateProblem(date);
      if (selling) {
        const parsed = parsePlanned(amount);
        if (amount.trim() === '') found.amount = t('amountRequired');
        else if (!parsed.ok) found.amount = t('amountInvalid');
        else minor = parsed.minor;
      }
    }
    for (const c of ticked) {
      const own = choices[c.id]?.date ?? null;
      if (own === null && saleDate === '') continue;
      const problem = dateProblem(effective(c.id));
      if (problem) found.credits[c.id] = problem;
    }
    setErrors(found);
    setPickError(pick);
    if (pick) {
      searchRef.current?.focus();
      return;
    }
    if (found.date || found.amount || Object.keys(found.credits).length > 0) return;

    const settle = ticked.map((c) => ({ liabilityId: c.id, date: effective(c.id) }));
    const base = settle.length > 0 ? { settle } : {};
    const input =
      mode === 'written_off'
        ? { kind: mode, date, ...base }
        : entry === 'link'
          ? { kind: mode, transactionId: selected!.id, ...base }
          : { kind: mode, date, amount: minor, ...base };
    start(async () => {
      const result = await disposeAssetAction(asset.id, input);
      if (!result.ok) {
        const code = result.code === 'validation' ? result.detail?.code : undefined;
        const message = failure(result);
        if (code === 'sale_transaction_invalid' || code === 'sale_transaction_taken') {
          setPickError(message);
        } else if (code === 'sale_needs_amount') {
          setErrors((prev) => ({ ...prev, amount: message }));
        } else if (code === 'date_in_future' && entry === 'hand') {
          setErrors((prev) => ({ ...prev, date: message }));
        } else {
          setFormError(message);
        }
        return;
      }
      saved.current = true;
      toast.success(t(selling ? 'doneSell' : 'doneWriteOff'));
      onOpenChange(false);
      onDone();
      router.refresh();
    });
  }

  const amountOk = selling && entry === 'hand' && amount.trim() !== '' && parsePlanned(amount).ok;
  const parsedAmount = parsePlanned(amount);
  let summary = '';
  if (selling) {
    if (entry === 'link') {
      summary = selected
        ? t('summarySale', {
            date: formatDayYear(selected.bookingDate, locale),
            amount: formatMoney(selected.amount, selected.currency, locale),
          })
        : t('summaryChoose');
    } else if (amountOk && parsedAmount.ok && isIsoDate(date)) {
      summary = t('summarySale', {
        date: formatDayYear(date, locale),
        amount: formatMoney(parsedAmount.minor, asset.currency, locale),
      });
    }
  } else if (isIsoDate(date)) {
    summary = t('summaryWriteOff', { date: formatDayYear(date, locale) });
  }
  if (summary && ticked.length > 0) summary += t('summarySettles', { count: ticked.length });

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      tall={selling}
      title={t(selling ? 'sheetSell' : 'sheetWriteOff')}
      description={t(selling ? 'sheetSellDescription' : 'sheetWriteOffDescription', {
        name: asset.name,
      })}
      onCloseAutoFocus={(event) => {
        // The button that opened this is gone once the page changes state: the page moves focus.
        if (saved.current) event.preventDefault();
      }}
      footer={
        <div className="grid gap-2">
          <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
            {summary}
          </p>
          <Button type="submit" form={formId} loading={pending} className="w-full md:w-auto">
            {pending ? t('submitting') : t(selling ? 'submitSell' : 'submitWriteOff')}
          </Button>
        </div>
      }
    >
      <form method="post" id={formId} onSubmit={submit} noValidate className="grid gap-5 pt-2">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {asset.accountName ? (
          <Alert tone="info">{t('accountNote', { account: asset.accountName })}</Alert>
        ) : null}

        {selling ? (
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">{t('modeLegend')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['link', 'hand'] as const).map((value) => (
                <label
                  key={value}
                  className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name="entry"
                    checked={entry === value}
                    onChange={() => chooseEntry(value)}
                    className="size-5 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="text-base">{t(value === 'link' ? 'modeLink' : 'modeHand')}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        {selling && entry === 'link' ? (
          <SaleTransactionPicker
            candidates={candidates}
            selectedId={selected?.id ?? null}
            onSelect={(c) => {
              setSelected(c);
              setPickError(null);
            }}
            currency={asset.currency}
            error={pickError}
            searchRef={searchRef}
            onEnterByHand={() => chooseEntry('hand', true)}
          />
        ) : (
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field label={t(selling ? 'saleDate' : 'writeOffDate')} error={errors.date}>
              {(p) => (
                <Input
                  {...p}
                  ref={dateRef}
                  type="date"
                  name="date"
                  value={date}
                  max={today}
                  required
                  onChange={(e) => {
                    setDate(e.target.value);
                    setErrors((prev) => ({ ...prev, date: undefined }));
                  }}
                />
              )}
            </Field>
            {selling ? (
              <Field
                label={t('saleAmount')}
                hint={t('saleAmountHint', { currency: asset.currency })}
                error={errors.amount}
              >
                {(p) => (
                  <Input
                    {...p}
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    className="text-right tabular-nums"
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setErrors((prev) => ({ ...prev, amount: undefined }));
                    }}
                  />
                )}
              </Field>
            ) : null}
          </div>
        )}

        {credits.length > 0 ? (
          <LinkedCredits
            mode={mode}
            credits={credits}
            choices={choices}
            saleDate={saleDate}
            today={today}
            errors={errors.credits}
            onChange={(id, next) => {
              setChoices((prev) => ({ ...prev, [id]: next }));
              setErrors((prev) => ({ ...prev, credits: { ...prev.credits, [id]: '' } }));
            }}
          />
        ) : null}
      </form>
    </Sheet>
  );
}

/** One card per linked credit: ticked ones end with the disposal, on a date that follows it. */
function LinkedCredits({
  mode,
  credits,
  choices,
  saleDate,
  today,
  errors,
  onChange,
}: {
  mode: Mode;
  credits: LinkedLiabilityDto[];
  choices: Record<string, CreditChoice>;
  saleDate: string;
  today: string;
  errors: Record<string, string>;
  onChange: (id: string, next: CreditChoice) => void;
}) {
  const t = useTranslations('disposal.credits');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">{t('legend')}</legend>
      <p className="text-sm text-muted-foreground">
        {t(mode === 'sold' ? 'helpSell' : 'helpWriteOff')}
      </p>
      {credits.map((c) => {
        const choice = choices[c.id] ?? { checked: true, date: null };
        return (
          <div
            key={c.id}
            data-testid={`settle-${c.id}`}
            className="grid grid-cols-1 gap-2 rounded-md bg-surface-2 p-3"
          >
            <Checkbox
              checked={choice.checked}
              onChange={(e) => onChange(c.id, { ...choice, checked: e.target.checked })}
              label={c.name}
              hint={
                c.hasValue
                  ? t('owed', { amount: formatMoney(c.amount, c.currency, locale) })
                  : t('noBalance')
              }
            />
            {choice.checked ? (
              <Field
                label={
                  <>
                    {t('settledOn')}
                    <span className="sr-only">, {c.name}</span>
                  </>
                }
                error={errors[c.id] || undefined}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    max={today}
                    value={choice.date ?? saleDate}
                    required
                    onChange={(e) => onChange(c.id, { ...choice, date: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(mode === 'sold' ? 'staysSold' : 'staysWrittenOff')}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
