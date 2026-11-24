import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { HouseholdFormatProvider } from '../household-format';
import { PrivacyProvider } from '../privacy';
import { ToastProvider } from '../ui/toast';
import type { ChatProposal } from './advisor-types';
import { ProposalCard } from './proposal-card';

vi.mock('@/app/actions/privacy', () => ({ setPrivacyAction: vi.fn() }));
vi.mock('@/server/actions/advisor', () => ({
  applyAdvisorProposalAction: vi.fn(),
  dismissAdvisorProposalAction: vi.fn(),
}));

const proposal = (over: Partial<ChatProposal> = {}): ChatProposal => ({
  id: 'p-1',
  kind: 'budget_line_amount',
  payload: {
    kind: 'budget_line_amount',
    lineId: 'line-1',
    monthlyAmount: '250.00',
    fromMonth: '2026-12',
    reason: 'Dining is above your usual range.',
  },
  basis: { months: 3, min: 20000, max: 30000, median: 25000, currency: 'EUR' },
  status: 'pending',
  ...over,
});

function render(node: ReactNode, hidden = false) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HouseholdFormatProvider value={{ locale: 'en', timeZone: 'UTC', currency: 'EUR' }}>
        <PrivacyProvider initialHidden={hidden}>
          <ToastProvider>{node}</ToastProvider>
        </PrivacyProvider>
      </HouseholdFormatProvider>
    </NextIntlClientProvider>,
  );
}

const card = (p: ChatProposal, canApply: boolean) => (
  <ProposalCard proposal={p} canApply={canApply} onStatus={() => {}} onRefresh={() => {}} />
);

describe('ProposalCard', () => {
  it('shows the summary, the reason and the basis line through the money helpers', () => {
    const html = render(card(proposal(), true));
    expect(html).toContain('Set a budget line to €250.00 a month from December 2026');
    expect(html).toContain('Dining is above your usual range.');
    expect(html).toContain('Last 3 months: €200.00–€300.00, median €250.00');
  });

  it('offers Apply and Dismiss to owners and members', () => {
    const html = render(card(proposal(), true));
    expect(html).toContain('>Apply<');
    expect(html).toContain('>Dismiss<');
  });

  it('hides Apply and Dismiss from a viewer and says why', () => {
    const html = render(card(proposal(), false));
    expect(html).not.toContain('>Apply<');
    expect(html).not.toContain('>Dismiss<');
    expect(html).toContain('Only owners and members can apply this.');
    expect(html).toContain('Last 3 months');
  });

  it('masks the basis amounts in privacy mode', () => {
    const html = render(card(proposal(), true), true).replace(/<[^>]*>/g, ' ');
    expect(html).toContain('Last 3 months');
    expect(html).not.toMatch(/€\s?200|300\.00/);
  });

  it('omits the basis line when there is none', () => {
    expect(render(card(proposal({ basis: null }), true))).not.toContain('Last 3 months');
  });

  it('shows the applied state without actions', () => {
    const html = render(card(proposal({ status: 'applied' }), true));
    expect(html).toContain('Applied');
    expect(html).not.toContain('>Apply<');
    expect(html).not.toContain('>Dismiss<');
  });

  it('shows the dismissed state without actions', () => {
    const html = render(card(proposal({ status: 'dismissed' }), true));
    expect(html).toContain('Dismissed');
    expect(html).not.toContain('>Apply<');
  });

  it('shows a stale proposal as out of date, with no Apply', () => {
    const html = render(card(proposal({ status: 'stale' }), true));
    expect(html).toContain('Out of date');
    expect(html).toContain('Your data changed since this was suggested. Ask again.');
    expect(html).not.toContain('>Apply<');
  });
});
