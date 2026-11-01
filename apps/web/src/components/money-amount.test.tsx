import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../messages/pt-PT.json';
import { HouseholdFormatProvider } from './household-format';
import { MoneyAmount } from './money-amount';
import { PrivacyProvider } from './privacy';

vi.mock('@/app/actions/privacy', () => ({ setPrivacyAction: vi.fn() }));

function render(node: ReactNode, hidden: boolean): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="pt-PT" messages={messages}>
      <HouseholdFormatProvider
        value={{ locale: 'pt-PT', timeZone: 'Europe/Lisbon', currency: 'EUR' }}
      >
        <PrivacyProvider initialHidden={hidden}>{node}</PrivacyProvider>
      </HouseholdFormatProvider>
    </NextIntlClientProvider>,
  ).replace(/\s/g, ' ');
}

describe('MoneyAmount in privacy mode', () => {
  it('masks the amount but keeps the sign and the spoken meaning', () => {
    const html = render(<MoneyAmount minor={-123456} currency="EUR" kind="expense" />, true);
    expect(html).toContain('−');
    expect(html).toContain('•••• €');
    expect(html.replace(/<[^>]*>/g, '')).not.toMatch(/\d/);
    expect(html).toContain('sr-only');
  });

  it('does not dim cents of a masked hero amount', () => {
    const html = render(<MoneyAmount minor={123456} currency="EUR" size="hero" dimCents />, true);
    expect(html).not.toContain('text-[0.6em]');
    expect(html).toContain('•••• €');
  });

  it('shows the amount when privacy mode is off', () => {
    expect(render(<MoneyAmount minor={123456} currency="EUR" />, false)).toContain('1 234,56');
  });
});
