import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { markLogoFailed, resetFailedLogos } from '@/lib/merchant-logo';
import messages from '../../../messages/pt-PT.json';
import { HouseholdFormatProvider } from '../household-format';
import { PrivacyProvider } from '../privacy';
import { MerchantAvatar } from '../merchant-avatar';
import { DetailFieldRow, IbanValue } from './transaction-detail-fields';

afterEach(resetFailedLogos);

function render(node: ReactNode, hidden = false): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="pt-PT" messages={messages}>
      <HouseholdFormatProvider
        value={{ locale: 'pt-PT', timeZone: 'Europe/Lisbon', currency: 'EUR' }}
      >
        <PrivacyProvider initialHidden={hidden}>{node}</PrivacyProvider>
      </HouseholdFormatProvider>
    </NextIntlClientProvider>,
  );
}

describe('MerchantAvatar', () => {
  it('shows only the category disc when the merchant has no logo (no image request)', () => {
    const html = render(
      <MerchantAvatar merchant={{ id: 'm1', hasLogo: false }} category={undefined} />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('size-9');
  });

  it('shows only the category disc without a merchant', () => {
    expect(render(<MerchantAvatar merchant={null} category={undefined} size={48} />)).not.toContain(
      '<img',
    );
  });

  it('lays a decorative, lazy logo over the category disc when one exists', () => {
    const html = render(
      <MerchantAvatar merchant={{ id: 'm1', hasLogo: true }} category={undefined} />,
    );
    expect(html).toContain('src="/api/merchants/m1/logo"');
    expect(html).toContain('alt=""');
    expect(html).toContain('loading="lazy"');
    // The category disc stays underneath as the fallback.
    expect(html.indexOf('border-dashed')).toBeLessThan(html.indexOf('<img'));
  });

  it('falls back to the category disc for a logo that already failed', () => {
    markLogoFailed('m1');
    expect(
      render(<MerchantAvatar merchant={{ id: 'm1', hasLogo: true }} category={undefined} />),
    ).not.toContain('<img');
  });
});

describe('IbanValue', () => {
  const html = render(<IbanValue iban="PT50000201231234567890154" />);

  it('hides the number: masked visually, only the ending for screen readers', () => {
    expect(html).not.toContain('0002');
    expect(html).toContain('PT50 •••• … 9015 4');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('IBAN oculto, termina em 90154');
  });

  it('offers a reveal toggle and a copy button with accessible names', () => {
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('aria-label="Mostrar IBAN completo"');
    expect(html).toContain('>Mostrar<');
    expect(html).toContain('aria-label="Copiar IBAN"');
  });
});

describe('DetailFieldRow', () => {
  it('renders location, MCC and exchange rate copy', () => {
    expect(
      render(
        <dl>
          <DetailFieldRow field={{ id: 'location', city: 'Lisboa', country: 'Portugal' }} />
        </dl>,
      ),
    ).toContain('Lisboa, Portugal');
    expect(
      render(
        <dl>
          <DetailFieldRow field={{ id: 'mcc', code: '5411', label: 'Supermercados' }} />
        </dl>,
      ),
    ).toContain('Supermercados (MCC 5411)');
    const fx = render(
      <dl>
        <DetailFieldRow
          field={{
            id: 'originalAmount',
            amount: -2000,
            currency: 'USD',
            rate: { from: 'USD', value: '0,9213', to: '€' },
          }}
        />
      </dl>,
    );
    expect(fx).toContain('1 USD = 0,9213 €');
    expect(fx).toContain('Valor original');
  });

  it('pluralises shares in the instrument line', () => {
    const one = render(
      <dl>
        <DetailFieldRow
          field={{
            id: 'instrument',
            ticker: 'AAPL',
            shares: 1,
            price: { minor: 24, currency: 'USD' },
          }}
        />
      </dl>,
    );
    expect(one).toContain('AAPL · 1 ação × ');
    const many = render(
      <dl>
        <DetailFieldRow
          field={{
            id: 'instrument',
            ticker: 'AAPL',
            shares: 10,
            price: { minor: 24, currency: 'USD' },
          }}
        />
      </dl>,
    );
    expect(many).toContain('AAPL · 10 ações × ');
  });

  it('masks the share count in privacy mode, since shares × a public price is the trade value', () => {
    const html = render(
      <dl>
        <DetailFieldRow
          field={{
            id: 'instrument',
            ticker: 'AAPL',
            shares: 10,
            price: { minor: 24, currency: 'USD' },
          }}
        />
      </dl>,
      true,
    );
    expect(html).toContain('AAPL · •••• ações × ');
    expect(html).not.toContain('10 ações');
  });
});
