import { addDays, addMonths, isIsoDate, monthEnd, monthStart } from './dates';

export const PERIODS = [
  'this-month',
  'last-month',
  'last-90',
  'this-year',
  'all',
  'custom',
] as const;
export type Period = (typeof PERIODS)[number];

export interface TxFilters {
  period: Period;
  /** Only for `custom`. */
  from?: string;
  to?: string;
  accountIds: string[];
  categoryIds: string[];
  /** Only rows waiting in the review inbox. */
  review: boolean;
  /** Only money out ('out') or money in ('in'). */
  direction?: 'in' | 'out';
  /** Only pending (not yet booked) rows. */
  pending: boolean;
  /** Only booked rows (`?status=booked`), so pending ones do not mix into a total. */
  booked?: true;
  /** Leave out transfers (`?transfers=exclude`), as the analytics do. */
  excludeTransfers?: true;
  /** Only transfers (`?transfers=only`), e.g. what a saving budget line counts. */
  transfersOnly?: true;
  /** Only rows with no category (`?uncategorised=1`), transfers aside. */
  uncategorised?: true;
  /** Only rows the AI categorised (`?by=ai`). */
  by?: 'ai';
  /** Free text over description, counterparty and notes. */
  q: string;
}

export const DEFAULT_PERIOD: Period = 'this-month';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 20;

const isPeriod = (v: string | null): v is Period => PERIODS.includes(v as Period);

/** Reads filters from a query string; anything malformed is dropped rather than rejected. */
export function parseFilters(
  params: URLSearchParams,
  defaultPeriod: Period = DEFAULT_PERIOD,
): TxFilters {
  const periodParam = params.get('period');
  let period: Period = isPeriod(periodParam) ? periodParam : defaultPeriod;
  const from = params.get('from');
  const to = params.get('to');
  const validFrom = from && isIsoDate(from) ? from : undefined;
  const validTo = to && isIsoDate(to) ? to : undefined;
  if (period === 'custom' && !validFrom && !validTo) period = defaultPeriod;
  const ids = (key: string) =>
    [...new Set(params.getAll(key).filter((v) => UUID.test(v)))].slice(0, MAX_IDS);
  return {
    period,
    ...(period === 'custom' ? { from: validFrom, to: validTo } : {}),
    accountIds: ids('account'),
    categoryIds: ids('category'),
    review: params.get('review') === '1',
    ...(params.get('type') === 'in' || params.get('type') === 'out'
      ? { direction: params.get('type') as 'in' | 'out' }
      : {}),
    pending: params.get('pending') === '1',
    // Booked-only and pending-only exclude each other: pending wins, as the list does.
    ...(params.get('status') === 'booked' && params.get('pending') !== '1'
      ? { booked: true as const }
      : {}),
    ...(params.get('transfers') === 'exclude' ? { excludeTransfers: true as const } : {}),
    ...(params.get('transfers') === 'only' ? { transfersOnly: true as const } : {}),
    ...(params.get('uncategorised') === '1' ? { uncategorised: true as const } : {}),
    ...(params.get('by') === 'ai' ? { by: 'ai' as const } : {}),
    q: (params.get('q') ?? '').trim().slice(0, 200),
  };
}

/** The query string for `filters`; defaults are omitted so the plain list has a clean URL. */
export function filtersToParams(
  f: TxFilters,
  defaultPeriod: Period = DEFAULT_PERIOD,
): URLSearchParams {
  const params = new URLSearchParams();
  if (f.period !== defaultPeriod) params.set('period', f.period);
  if (f.period === 'custom') {
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
  }
  for (const id of f.accountIds) params.append('account', id);
  for (const id of f.categoryIds) params.append('category', id);
  if (f.review) params.set('review', '1');
  if (f.direction) params.set('type', f.direction);
  if (f.pending) params.set('pending', '1');
  if (f.booked) params.set('status', 'booked');
  if (f.excludeTransfers) params.set('transfers', 'exclude');
  else if (f.transfersOnly) params.set('transfers', 'only');
  if (f.uncategorised) params.set('uncategorised', '1');
  if (f.by) params.set('by', f.by);
  if (f.q) params.set('q', f.q);
  return params;
}

/** The inclusive date range a filter selects, given today in the household time zone. */
export function resolveRange(f: TxFilters, today: string): { from?: string; to?: string } {
  switch (f.period) {
    case 'this-month':
      return { from: monthStart(today), to: monthEnd(today) };
    case 'last-month': {
      const prev = addMonths(today, -1);
      return { from: monthStart(prev), to: monthEnd(prev) };
    }
    case 'last-90':
      return { from: addDays(today, -89), to: today };
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'custom':
      return { from: f.from, to: f.to };
    case 'all':
      return {};
  }
}

/** Filters beyond the default period that the user could clear (drives the "Limpar" chip). */
export function activeFilterCount(f: TxFilters, defaultPeriod: Period = DEFAULT_PERIOD): number {
  return (
    (f.period !== defaultPeriod ? 1 : 0) +
    (f.accountIds.length > 0 ? 1 : 0) +
    (f.categoryIds.length > 0 ? 1 : 0) +
    (f.review ? 1 : 0) +
    (f.direction ? 1 : 0) +
    (f.pending ? 1 : 0) +
    (f.booked ? 1 : 0) +
    (f.excludeTransfers ? 1 : 0) +
    (f.transfersOnly ? 1 : 0) +
    (f.uncategorised ? 1 : 0) +
    (f.by ? 1 : 0) +
    (f.q ? 1 : 0)
  );
}

export function emptyFilters(defaultPeriod: Period = DEFAULT_PERIOD): TxFilters {
  return {
    period: defaultPeriod,
    accountIds: [],
    categoryIds: [],
    review: false,
    pending: false,
    q: '',
  };
}
