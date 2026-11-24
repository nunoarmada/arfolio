import { describe, expect, it } from 'vitest';
import { sanitiseToolOutput } from '../src/advisor/sanitise.js';

const IBAN = 'DE89370400440532013000';
const SUFFIX = '…[truncated: ask a narrower question]';

describe('sanitiseToolOutput', () => {
  it('masks identifiers inside free-text fields', () => {
    const out = sanitiseToolOutput({
      transactions: [
        {
          description: `Transfer to ${IBAN} rent`,
          counterparty: 'jane@example.test',
          merchant_raw: 'SHOP 1234567890',
          raw_text: 'card 4111 1111 1111 1111',
          category: 'Food',
        },
      ],
    });
    expect(out).not.toContain(IBAN);
    expect(out).not.toContain('jane@example.test');
    expect(out).not.toContain('1234567890');
    expect(out).not.toContain('4111');
    expect(out).toContain('Transfer to # rent');
    expect(out).toContain('"category":"Food"');
  });

  it('removes notes, iban and account_number at any depth', () => {
    const out = JSON.parse(
      sanitiseToolOutput({
        notes: 'private',
        accounts: [{ name: 'Main', iban: IBAN, account_number: '123', nested: { notes: 'x' } }],
      }),
    );
    expect(out).toEqual({ accounts: [{ name: 'Main', nested: {} }] });
  });

  it('leaves other strings, numbers and nulls as they are', () => {
    expect(sanitiseToolOutput({ name: `Savings ${IBAN}`, n: 3, none: null, ok: true })).toBe(
      JSON.stringify({ name: `Savings ${IBAN}`, n: 3, none: null, ok: true }),
    );
  });

  it('cuts a huge output and says so', () => {
    const out = sanitiseToolOutput({ rows: 'x'.repeat(50_000) });
    expect(out.length).toBeLessThanOrEqual(20_100);
    expect(out.endsWith(SUFFIX)).toBe(true);
  });

  it('does not touch an output under the cap', () => {
    const out = sanitiseToolOutput({ rows: 'x'.repeat(100) });
    expect(out.endsWith(SUFFIX)).toBe(false);
  });
});
