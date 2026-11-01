import type { ChartRow } from './net-worth-chart';
import { divergesFromPlan } from './net-worth-schedule';

/**
 * The deciding parts of the detail pages and the headline change, kept pure so they can be tested
 * without a database: which figure is "current", where it comes from, and when it drifts from the
 * repayment plan.
 */

export type ChangeInfo =
  | { kind: 'up' | 'down' | 'flat'; amount: number; prevMonth: string }
  | { kind: 'first' }
  | { kind: 'unknown' };

/** The newest month against the one before it (the latest earlier month that has a record). */
export function changeFromRows(rows: readonly ChartRow[] | null): ChangeInfo {
  if (!rows) return { kind: 'unknown' };
  const last = rows.at(-1);
  const prev = rows.at(-2);
  if (!last || last.change === null || !prev) return { kind: 'first' };
  return {
    kind: last.change > 0 ? 'up' : last.change < 0 ? 'down' : 'flat',
    amount: Math.abs(last.change),
    prevMonth: prev.month,
  };
}

interface Entry {
  asOf: string;
  amount: number;
  method: string;
}

/** The range and evidence an AI valuation is stored with (low and high in minor units). */
export interface AiEstimate {
  low: number;
  high: number;
  confidence: 'low' | 'medium' | 'high';
  sources: Array<{ title: string; url: string }>;
}

export interface CurrentAiEstimate extends AiEstimate {
  asOf: string;
  /** The model's reasoning, kept in the valuation's note. */
  rationale: string | null;
}

/** An account's line in the net worth: its amount is positive, `side` says where it counts. */
export interface AccountFigure {
  side: 'asset' | 'liability';
  amount: number;
  asOf: string | null;
}

interface ItemFigure {
  hasValue: boolean;
  amount: number;
  asOf: string | null;
}

export interface AssetCurrent {
  hasValue: boolean;
  amount: number;
  asOf: string | null;
  /** manual, import, connector, ai (valuations), or `account` when an account supplies the value. */
  method: string | null;
}

export function assetCurrent(input: {
  accountId: string | null;
  accountItem: AccountFigure | null;
  item: ItemFigure | undefined;
  /** Newest first. */
  entries: readonly Entry[];
  today: string;
  depreciationBps: number | null;
}): { current: AssetCurrent; estimateFrom: { amount: number; asOf: string } | null } {
  const none: AssetCurrent = { hasValue: false, amount: 0, asOf: null, method: null };
  if (input.accountId) {
    const a = input.accountItem;
    return {
      current: a
        ? {
            hasValue: true,
            amount: a.side === 'asset' ? a.amount : -a.amount,
            asOf: a.asOf,
            method: 'account',
          }
        : none,
      estimateFrom: null,
    };
  }
  // The valuation a depreciating estimate starts from: the newest real one on or before today.
  const base = input.entries.find((e) => e.method !== 'depreciation' && e.asOf <= input.today);
  return {
    current: input.item?.hasValue
      ? {
          hasValue: true,
          amount: input.item.amount,
          asOf: input.item.asOf,
          method: base?.method ?? null,
        }
      : none,
    estimateFrom:
      input.depreciationBps !== null && base ? { amount: base.amount, asOf: base.asOf } : null,
  };
}

/**
 * The AI estimate behind an asset's current value: the newest real valuation on or before today,
 * when that one came from the AI and kept its range. A newer manual value replaces it.
 */
export function currentAiEstimate(input: {
  /** Newest first. */
  entries: ReadonlyArray<Entry & { note?: string | null; estimate?: AiEstimate | null }>;
  today: string;
}): CurrentAiEstimate | null {
  const base = input.entries.find((e) => e.method !== 'depreciation' && e.asOf <= input.today);
  if (!base || base.method !== 'ai' || !base.estimate) return null;
  return { asOf: base.asOf, ...base.estimate, rationale: base.note ?? null };
}

export type AiStatus =
  | { kind: 'householdOff' | 'queued' | 'first' | 'monthly' }
  | { kind: 'missing'; fields: string[] }
  | { kind: 'error'; code: string };

/**
 * The one line that says where an AI-valued asset stands: what stops it (household switch off,
 * missing details), what is under way, what went wrong last time, or the plain monthly note.
 * Null when AI is off for the asset.
 */
export function aiStatus(input: {
  aiValuation: boolean;
  householdAiEnabled: boolean;
  readiness: { eligible: boolean; missing: readonly string[] };
  aiRequestedAt: string | null;
  aiLastError: string | null;
  hasValue: boolean;
}): AiStatus | null {
  if (!input.aiValuation) return null;
  if (!input.householdAiEnabled) return { kind: 'householdOff' };
  if (!input.readiness.eligible) return { kind: 'missing', fields: [...input.readiness.missing] };
  if (input.aiRequestedAt) return { kind: 'queued' };
  if (input.aiLastError) return { kind: 'error', code: input.aiLastError };
  return { kind: input.hasValue ? 'monthly' : 'first' };
}

/**
 * The sources worth linking: web addresses only (the model's text is never trusted as a link),
 * each with its host so the reader sees where it leads. `title` is null when the source has none
 * of its own (an untitled source is stored under its host).
 */
export function sourceLinks(
  sources: ReadonlyArray<{ title: string; url: string }>,
): Array<{ href: string; title: string | null; host: string }> {
  const links: Array<{ href: string; title: string | null; host: string }> = [];
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const host = url.hostname.replace(/^www\./, '');
    const title = source.title.trim();
    links.push({
      href: url.href,
      title: title && title !== host && title !== url.hostname ? title : null,
      host,
    });
  }
  return links;
}

export type BalanceCaption =
  | { kind: 'bank' | 'recorded'; asOf: string }
  | { kind: 'account' }
  | { kind: 'schedule' }
  | { kind: 'principal' }
  | { kind: 'none' };

export function liabilityCurrent(input: {
  accountId: string | null;
  accountItem: AccountFigure | null;
  item: ItemFigure | undefined;
  /** Newest first. */
  entries: readonly Entry[];
  today: string;
  plan: { planBalance: number } | null;
}): {
  current: { hasValue: boolean; amount: number; caption: BalanceCaption };
  /** The recorded (not planned) amount owed, when there is one. */
  real: number | null;
  divergence: { real: number; plan: number } | null;
} {
  const nothing = { hasValue: false, amount: 0, caption: { kind: 'none' } as BalanceCaption };
  let current = nothing;
  let real: number | null = null;
  if (input.accountId) {
    const a = input.accountItem;
    if (a) {
      current = { hasValue: true, amount: a.amount, caption: { kind: 'account' } };
      real = a.amount;
    }
  } else if (input.item?.hasValue) {
    const recorded = input.entries.find((e) => e.asOf <= input.today);
    if (input.item.asOf !== null && recorded) {
      current = {
        hasValue: true,
        amount: input.item.amount,
        caption:
          recorded.method === 'connector'
            ? { kind: 'bank', asOf: input.item.asOf }
            : { kind: 'recorded', asOf: input.item.asOf },
      };
      real = input.item.amount;
    } else {
      current = {
        hasValue: true,
        amount: input.item.amount,
        caption: input.plan ? { kind: 'schedule' } : { kind: 'principal' },
      };
    }
  }
  const divergence =
    input.plan && real !== null && divergesFromPlan(real, input.plan.planBalance)
      ? { real, plan: input.plan.planBalance }
      : null;
  return { current, real, divergence };
}
