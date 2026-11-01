import { describe, expect, it } from 'vitest';
import type { Account, TransactionListRow } from '@arfolio/services';
import { toAccountDto, toTxDto } from './serialize';

const account = {
  id: 'a1',
  name: 'Current',
  type: 'checking',
  currency: 'EUR',
  institutionName: null,
  ibanLast4: '0001',
  openingBalance: 0,
  openingBalanceDate: null,
  includeInBudget: true,
  includeInNetWorth: true,
  archivedAt: null,
  connectionId: null,
  creditLimit: null,
} as unknown as Account;

const row = {
  id: 't1',
  accountId: 'a1',
  bookingDate: '2026-10-01',
  valueDate: null,
  amount: -1000,
  currency: 'EUR',
  status: 'booked',
  rawDescription: 'Shop',
  counterparty: null,
  categoryId: null,
  categorisedBy: null,
  confidence: null,
  aiSuggestedCategoryId: 'c1',
  aiConfidence: 0.7,
  needsReview: true,
  transferGroupId: null,
  notes: null,
  source: 'connector',
  importBatchId: null,
  userEditedAt: null,
} as unknown as TransactionListRow;

describe('toAccountDto', () => {
  it('exposes the connection an account is linked to, or null', () => {
    expect(toAccountDto(account).connectionId).toBeNull();
    expect(toAccountDto({ ...account, connectionId: 'conn-1' }).connectionId).toBe('conn-1');
  });
});

describe('toTxDto', () => {
  it('carries the merchant and location of the row, or null for both', () => {
    const merchant = { id: 'm1', name: 'Pingo Doce', domain: 'pingodoce.pt', hasLogo: true };
    const location = { city: 'Lisbon', country: 'PT' };
    expect(toTxDto({ ...row, merchant, location })).toMatchObject({ merchant, location });
    expect(toTxDto({ ...row, merchant: null, location: null })).toMatchObject({
      merchant: null,
      location: null,
    });
  });

  it('exposes the AI suggestion, its confidence and who categorised the row', () => {
    expect(toTxDto(row)).toMatchObject({
      aiSuggestedCategoryId: 'c1',
      aiConfidence: 0.7,
      categorisedBy: null,
    });
    expect(
      toTxDto({ ...row, categoryId: 'c2', categorisedBy: 'ai', aiConfidence: 0.92 }),
    ).toMatchObject({
      categoryId: 'c2',
      categorisedBy: 'ai',
      aiConfidence: 0.92,
    });
  });

  it('carries the purchase date, instant and MCC', () => {
    const occurredAt = new Date('2026-10-01T10:15:00.000Z');
    const dto = toTxDto({
      ...row,
      transactionDate: '2026-09-30',
      occurredAt,
      mcc: '5411',
      merchant: { id: 'm1', name: 'Continente', domain: 'continente.pt', hasLogo: true },
      location: { city: 'Lisboa', country: 'PT' },
    });
    expect(dto).toMatchObject({
      transactionDate: '2026-09-30',
      occurredAt: occurredAt.toISOString(),
      mcc: '5411',
      merchant: { id: 'm1', name: 'Continente', domain: 'continente.pt', hasLogo: true },
      location: { city: 'Lisboa', country: 'PT' },
    });
  });
});
