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
    fromMonth: '2026-06',
    reason: 'Dining is above your usual range.',
  },
  basis: { months: 3, min: 20000, max: 30000, median: 25000, currency: 'EUR' },
  display: { lineName: 'Restaurants', toMonth: '2026-12' },
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
    expect(html).toContain(
      'Set the budget line “Restaurants” to €250.00 a month, from June 2026 to December 2026',
    );
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

  it('blurs the model-written reason in privacy mode, and not otherwise', () => {
    const reason = 'Dining is above your usual range.';
    const masked = render(card(proposal(), true), true);
    expect(masked).toMatch(new RegExp(`<div[^>]*blur-sm[^>]*>${reason}`));
    expect(render(card(proposal(), true))).not.toContain('blur-sm');
  });

  it('only a dismissed card is shown at reduced emphasis', () => {
    expect(render(card(proposal({ status: 'dismissed' }), true))).toContain(
      'text-muted-foreground',
    );
    const applied = render(card(proposal({ status: 'applied' }), true));
    expect(applied).not.toMatch(/<p[^>]*text-card-title[^>]*text-muted-foreground/);
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

  describe('what Apply will change', () => {
    const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

    it('names the goal and lists every field a goal update sets', () => {
      const html = text(
        render(
          card(
            proposal({
              kind: 'goal_update',
              payload: {
                kind: 'goal_update',
                goalId: 'g-1',
                targetAmount: '2000',
                targetDate: '2027-03-15',
                monthlyContribution: '150.50',
                reason: 'r',
              },
              basis: null,
              display: { goalName: 'Holiday' },
            }),
            true,
          ),
        ),
      );
      expect(html).toContain('Update the goal “Holiday”');
      expect(html).toContain('Target amount €2,000.00');
      expect(html).toContain('Target date March 15, 2027');
      expect(html).toContain('Monthly contribution €150.50');
    });

    it('describes a rule: its condition and the category it assigns', () => {
      const html = text(
        render(
          card(
            proposal({
              kind: 'rule_create',
              payload: {
                kind: 'rule_create',
                name: 'Cafes',
                categoryId: 'c-1',
                condition: {
                  descriptionContains: 'cafe',
                  amountMax: 2000,
                  direction: 'out',
                  accountIds: ['a-1'],
                },
                reason: 'r',
              },
              basis: null,
              display: { categoryName: 'Restaurants', accountNames: ['Main account'] },
            }),
            true,
          ),
        ),
      );
      expect(html).toContain('Create the rule “Cafes”');
      expect(html).toContain(
        'When description contains “cafe”, amount of at most €20.00, money out, in Main account',
      );
      expect(html).toContain('Category Restaurants');
    });

    const categorise = (applyToMerchant: boolean) =>
      proposal({
        kind: 'transaction_categorise',
        payload: {
          kind: 'transaction_categorise',
          transactionId: 't-1',
          categoryId: 'c-1',
          applyToMerchant,
          reason: 'r',
        },
        basis: null,
        display: {
          categoryName: 'Restaurants',
          transaction: {
            bookedOn: '2026-05-02',
            amount: -1200,
            currency: 'EUR',
            description: 'Example Cafe #',
          },
        },
      });

    it('shows the transaction, the target category and the merchant-wide effect', () => {
      const html = text(render(card(categorise(true), true)));
      expect(html).toContain('Change the category of a transaction to “Restaurants”');
      expect(html).toContain('Date May 2, 2026');
      expect(html).toContain('Amount -€12.00');
      expect(html).toContain('Description Example Cafe #');
      expect(html).toContain('Also applies to all movements of this merchant');
    });

    it('does not claim a merchant-wide effect when there is none', () => {
      expect(render(card(categorise(false), true))).not.toContain('all movements of this merchant');
    });

    it('masks the amount and blurs the description in privacy mode', () => {
      const html = render(card(categorise(false), true), true);
      expect(text(html)).not.toContain('12.00');
      expect(html).toMatch(/<div[^>]*blur-sm[^>]*>Example Cafe #/);
    });

    it('falls back to the draft alone when nothing could be resolved', () => {
      const html = text(
        render(
          card(
            proposal({
              kind: 'goal_update',
              payload: { kind: 'goal_update', goalId: 'g', targetAmount: '10', reason: 'r' },
              basis: null,
              display: null,
            }),
            true,
          ),
        ),
      );
      expect(html).toContain('Update a goal');
      expect(html).toContain('Target amount €10.00');
    });
  });
});
