import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/pt-PT.json';
import { HouseholdFormatProvider } from '../household-format';
import { ToastProvider } from '../ui/toast';
import { SyncAllButton } from './sync-all-button';

vi.mock('@/server/actions/connections', () => ({ syncAllAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const render = (variant: 'sidebar' | 'topbar' = 'sidebar') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="pt-PT" messages={messages}>
      <HouseholdFormatProvider value={{ locale: 'pt-PT', timeZone: 'UTC', currency: 'EUR' }}>
        <ToastProvider>
          <SyncAllButton variant={variant} />
        </ToastProvider>
      </HouseholdFormatProvider>
    </NextIntlClientProvider>,
  );

describe('SyncAllButton', () => {
  it.each(['sidebar', 'topbar'] as const)('is labelled with the localised name (%s)', (variant) => {
    const html = render(variant);
    expect(html).toContain('aria-label="Sincronizar tudo"');
    expect(html).toContain('aria-busy="false"');
  });

  it('is an icon-only 44 px button in the phone top bar', () => {
    const html = render('topbar');
    expect(html).toMatch(/<button[^>]*class="[^"]*size-11/);
    expect(html).not.toContain('Sincronizar tudo</span>');
  });

  it.each(['sidebar', 'topbar'] as const)(
    'stays disabled until the page has hydrated, so an early tap is not lost (%s)',
    (variant) => {
      expect(render(variant)).toMatch(/<button[^>]*disabled=""/);
    },
  );
});
