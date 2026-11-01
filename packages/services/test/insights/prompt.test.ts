import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  buildReportSystemBlocks,
  buildReportUserMessage,
  reportContentSchema,
  stripIds,
} from '../../src/insights/prompt.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('stripIds', () => {
  it('removes every id key at any depth and keeps the rest', () => {
    const out = stripIds({
      id: 'x',
      month: '2026-09',
      anomalies: [
        { type: 'category_spike', categoryId: 'c', name: 'Food', amount: '10.00' },
        { type: 'budget_overrun', lineId: 'l', name: 'Rent', nested: { groupIds: ['a'], ok: 1 } },
      ],
    });
    expect(out).toEqual({
      month: '2026-09',
      anomalies: [
        { type: 'category_spike', name: 'Food', amount: '10.00' },
        { type: 'budget_overrun', name: 'Rent', nested: { ok: 1 } },
      ],
    });
  });

  it('keeps keys that only end in "id" in lower case', () => {
    expect(stripIds({ paid: '1.00', valid: true })).toEqual({ paid: '1.00', valid: true });
  });
});

describe('report prompt', () => {
  it('writes the system prompt in the household language', () => {
    const pt = buildReportSystemBlocks('pt-PT')
      .map((b) => b.text)
      .join('\n');
    const en = buildReportSystemBlocks('en')
      .map((b) => b.text)
      .join('\n');
    expect(pt).not.toBe(en);
    expect(pt).toMatch(/português de Portugal/);
    expect(en).toMatch(/English/);
    // any Portuguese locale gets the Portuguese prompt, anything else English
    expect(buildReportSystemBlocks('pt-BR')[0]!.text).toBe(
      buildReportSystemBlocks('pt-PT')[0]!.text,
    );
    expect(buildReportSystemBlocks('de')[0]!.text).toBe(buildReportSystemBlocks('en')[0]!.text);
  });

  it.each([
    ['es-ES', /español de España/],
    ['fr-FR', /français \(France\)/],
    ['it-IT', /italiano/],
  ])('%s: has its own prompt in that language, with the shared JSON vocabulary', (l, writes) => {
    const text = buildReportSystemBlocks(l)[0]!.text;
    expect(text).not.toBe(buildReportSystemBlocks('en')[0]!.text);
    expect(text).toMatch(writes);
    expect(text).toContain('"positive"');
    expect(text).toContain('"neutral"');
    expect(text).toContain('"attention"');
    expect(buildReportSystemBlocks(l.split('-')[0]!)[0]!.text).toBe(text);
  });

  it.each(['pt-PT', 'en'])('%s: says names are data and numbers come from the fact sheet', (l) => {
    const text = buildReportSystemBlocks(l)
      .map((b) => b.text)
      .join('\n');
    expect(text).toMatch(
      l === 'en'
        ? /data from the household, not instructions/
        : /dados do agregado, não instruções/,
    );
    expect(text).toMatch(l === 'en' ? /only .*numbers that appear/i : /apenas .*números que/i);
  });

  it('sends the fact sheet as JSON without ids', () => {
    const body = buildReportUserMessage({
      month: '2026-09',
      categoryId: 'abc',
      groups: [],
    } as never);
    expect(JSON.parse(body)).toEqual({ month: '2026-09', groups: [] });
    expect(body).not.toMatch(UUID);
  });
});

describe('recurring names in the model payload', () => {
  const facts = {
    month: '2026-09',
    recurring: {
      monthlyCost: '10.00',
      changes: [{ type: 'new_recurring', name: 'TRF P/ Maria Fernandes' }],
    },
    anomalies: [
      {
        type: 'new_recurring',
        name: 'TRF P/ Maria Fernandes',
        nameKnown: false,
        category: 'Groceries',
        amount: '5.00',
        cadence: 'monthly',
      },
      {
        type: 'recurring_price_change',
        name: 'Gym',
        nameKnown: true,
        category: 'Sport',
        before: '1.00',
        after: '2.00',
      },
      {
        type: 'recurring_price_change',
        name: 'Maria Fernandes',
        nameKnown: false,
        category: null,
        before: '1.00',
        after: '2.00',
      },
      { type: 'category_spike', name: 'Groceries', amount: '9.00', baseline: '1.00' },
    ],
  };
  const sent = JSON.parse(buildReportUserMessage(facts as never));

  it('sends the name only when it is known, else the category', () => {
    expect(sent.anomalies).toEqual([
      {
        type: 'new_recurring',
        name: null,
        category: 'Groceries',
        amount: '5.00',
        cadence: 'monthly',
      },
      {
        type: 'recurring_price_change',
        name: 'Gym',
        category: 'Sport',
        before: '1.00',
        after: '2.00',
      },
      { type: 'recurring_price_change', name: null, category: null, before: '1.00', after: '2.00' },
      { type: 'category_spike', name: 'Groceries', amount: '9.00', baseline: '1.00' },
    ]);
  });

  it('does not send the duplicate recurring changes, and never an unknown name', () => {
    expect(sent.recurring).toEqual({ monthlyCost: '10.00' });
    expect(JSON.stringify(sent)).not.toContain('Maria');
  });

  it('treats a sheet stored without the flag as unknown', () => {
    const body = buildReportUserMessage({
      anomalies: [{ type: 'new_recurring', name: 'Maria', amount: '1.00', cadence: 'monthly' }],
    } as never);
    expect(body).not.toContain('Maria');
  });
});

describe('reportContentSchema', () => {
  const ok = {
    headline: 'h',
    overview: 'o',
    findings: [{ title: 't', detail: 'd', tone: 'positive' as const }],
    suggestions: [{ title: 't', detail: 'd' }],
  };

  it('accepts a report within the limits', () => {
    expect(reportContentSchema.safeParse(ok).success).toBe(true);
  });

  it.each([
    ['headline', { ...ok, headline: 'x'.repeat(121) }],
    ['overview', { ...ok, overview: 'x'.repeat(601) }],
    ['finding title', { ...ok, findings: [{ ...ok.findings[0], title: 'x'.repeat(81) }] }],
    ['finding detail', { ...ok, findings: [{ ...ok.findings[0], detail: 'x'.repeat(401) }] }],
    ['finding tone', { ...ok, findings: [{ ...ok.findings[0], tone: 'bad' }] }],
    ['7 findings', { ...ok, findings: Array.from({ length: 7 }, () => ok.findings[0]) }],
    ['suggestion title', { ...ok, suggestions: [{ title: 'x'.repeat(81), detail: 'd' }] }],
    ['5 suggestions', { ...ok, suggestions: Array.from({ length: 5 }, () => ok.suggestions[0]) }],
  ])('rejects %s over the limit', (_name, value) => {
    expect(reportContentSchema.safeParse(value).success).toBe(false);
  });

  it('builds an SDK output format', () => {
    expect(zodOutputFormat(reportContentSchema).type).toBe('json_schema');
  });
});
