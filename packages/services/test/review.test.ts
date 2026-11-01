import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createManualTransaction,
  listReviewInbox,
  reviewCount,
  updateTransaction,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

describe('review inbox', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;
  let ids: string[];
  let category: string;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    const account = await createAccount(a, { name: 'Main', type: 'checking' });
    const group = await createCategoryGroup(a, { name: 'G', kind: 'expense' });
    category = (await createCategory(a, { groupId: group.id, name: 'C' })).id;
    ids = [];
    for (let day = 1; day <= 5; day += 1) {
      const row = await createManualTransaction(a, {
        accountId: account.id,
        bookingDate: `2026-06-0${day}`,
        amount: -100 * day,
        description: `Unknown ${day}`,
      });
      ids.push(row.id);
    }
    await createManualTransaction(a, {
      accountId: account.id,
      bookingDate: '2026-06-09',
      amount: -1,
      description: 'Already sorted',
      categoryId: category,
    });
  });
  afterAll(() => t.close());

  it('lists only rows needing review, newest first, with paging', async () => {
    expect(await reviewCount(a)).toBe(5);
    const first = await listReviewInbox(a, { limit: 2 });
    expect(first.items.map((i) => i.bookingDate)).toEqual(['2026-06-05', '2026-06-04']);
    expect(first.nextCursor).toBeTruthy();
    const second = await listReviewInbox(a, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.bookingDate)).toEqual(['2026-06-03', '2026-06-02']);
    const last = await listReviewInbox(a, { limit: 2, cursor: second.nextCursor! });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it('shrinks as rows are reviewed', async () => {
    await updateTransaction(a, ids[0]!, { categoryId: category });
    expect(await reviewCount(a)).toBe(4);
    expect((await listReviewInbox(a, { limit: 50 })).items.map((i) => i.id)).not.toContain(ids[0]);
  });

  it('is scoped to the household, readable by viewers and validates paging', async () => {
    expect(await reviewCount(b)).toBe(0);
    expect((await listReviewInbox(b, { limit: 10 })).items).toEqual([]);
    expect(await reviewCount(withRole(a, 'viewer'))).toBe(4);
    await expect(listReviewInbox(a, { limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(listReviewInbox(a, { limit: 5, cursor: '!!' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
