import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/pt-PT.json';
import { PrivacyProvider } from '../privacy';
import { ToastProvider } from '../ui/toast';
import { PrivacyToggle } from './privacy-toggle';

vi.mock('@/app/actions/privacy', () => ({ setPrivacyAction: vi.fn() }));

const render = (hidden: boolean, variant: 'sidebar' | 'topbar') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="pt-PT" messages={messages}>
      <ToastProvider>
        <PrivacyProvider initialHidden={hidden}>
          <PrivacyToggle variant={variant} />
        </PrivacyProvider>
      </ToastProvider>
    </NextIntlClientProvider>,
  );

describe('PrivacyToggle', () => {
  it.each(['sidebar', 'topbar'] as const)('offers to show amounts when hidden (%s)', (variant) => {
    const html = render(true, variant);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Mostrar montantes"');
  });

  it.each(['sidebar', 'topbar'] as const)('offers to hide amounts when visible (%s)', (variant) => {
    const html = render(false, variant);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Esconder montantes"');
  });

  it.each(['sidebar', 'topbar'] as const)(
    'stays disabled until the page has hydrated, so an early tap is not lost (%s)',
    (variant) => {
      expect(render(false, variant)).toMatch(/<button[^>]*disabled=""/);
    },
  );
});
