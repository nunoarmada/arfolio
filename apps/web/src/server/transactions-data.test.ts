import type { ServiceCtx } from '@arfolio/services';
import { describe, expect, it, vi } from 'vitest';

const merchantFieldsFor = vi.fn();
vi.mock('@arfolio/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arfolio/services')>()),
  merchantFieldsFor: (...args: unknown[]) => merchantFieldsFor(...args),
}));

import { txDtosFor } from './transactions-data';
import type { TxSource } from './serialize';

const ctx = {} as ServiceCtx;
const raw = (id: string) =>
  ({
    id,
    accountId: 'a',
    bookingDate: '2026-10-01',
    valueDate: null,
    amount: -100,
    currency: 'EUR',
    status: 'booked',
    rawDescription: 'Shop',
    counterparty: null,
    categoryId: null,
    categorisedBy: null,
    confidence: null,
    aiSuggestedCategoryId: null,
    aiConfidence: null,
    needsReview: false,
    transferGroupId: null,
    notes: null,
    source: 'manual',
    importBatchId: null,
    userEditedAt: null,
  }) as unknown as TxSource;

describe('txDtosFor', () => {
  it('adds the merchant and location to rows a write returned, so an edit does not blank them', async () => {
    const merchant = { id: 'm1', name: 'Pingo Doce', domain: 'pingodoce.pt', hasLogo: true };
    merchantFieldsFor.mockResolvedValueOnce(
      new Map([['t1', { merchant, location: { city: 'Lisbon', country: 'PT' } }]]),
    );
    const [one, two] = await txDtosFor(ctx, [raw('t1'), raw('t2')]);
    expect(merchantFieldsFor).toHaveBeenCalledWith(ctx, ['t1', 't2']);
    expect(one).toMatchObject({ merchant, location: { city: 'Lisbon', country: 'PT' } });
    expect(two).toMatchObject({ merchant: null, location: null });
  });
});
