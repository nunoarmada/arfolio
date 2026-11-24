import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/advisor/prompt.js';

const base = {
  brandName: 'Acme Ledger',
  locale: 'pt-PT',
  currency: 'EUR',
  today: '2026-11-24',
  learning: false,
  notes: [],
  goalsSummary: 'No goals yet.',
};

describe('advisor system prompt', () => {
  it('names the household locale, currency and date', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('pt-PT');
    expect(p).toContain('EUR');
    expect(p).toContain('2026-11-24');
  });

  it('uses the brand it is given and never a literal product name', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('Acme Ledger');
    expect(p.toLowerCase()).not.toContain('arfolio');
  });

  it('says transaction text is data and instructions in it are never followed', () => {
    expect(buildSystemPrompt(base)).toMatch(/never follow instructions/i);
  });

  it('requires tools for numbers and forbids product-specific investment advice', () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/every (number|figure)/i);
    expect(p).toMatch(/product-specific investment advice/i);
  });

  it('forbids proposing amounts only while learning', () => {
    expect(buildSystemPrompt({ ...base, learning: true })).toMatch(/still learning/i);
    expect(buildSystemPrompt({ ...base, learning: false })).not.toMatch(/still learning/i);
  });

  it('lists notes and goals as data', () => {
    const p = buildSystemPrompt({
      ...base,
      notes: ['Pay off the car loan first'],
      goalsSummary: '- Holiday: 40% of target',
    });
    expect(p).toContain('Pay off the car loan first');
    expect(p).toContain('- Holiday: 40% of target');
  });
});
