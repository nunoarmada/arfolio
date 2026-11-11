import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/pt-PT.json';
import { HouseholdFormatProvider } from '../household-format';
import { ToastProvider } from '../ui/toast';
import { SyncAllButton } from './sync-all-button';

vi.mock('@/server/actions/connections', () => ({ syncAllAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="pt-PT" messages={messages}>
      <HouseholdFormatProvider value={{ locale: 'pt-PT', timeZone: 'UTC', currency: 'EUR' }}>
        <ToastProvider>
          <SyncAllButton />
        </ToastProvider>
      </HouseholdFormatProvider>
    </NextIntlClientProvider>,
  );

describe('SyncAllButton', () => {
  it('is a labelled sidebar row with the localised name', () => {
    const html = render();
    expect(html).toContain('aria-label="Sincronizar tudo"');
    expect(html).toContain('aria-busy="false"');
  });

  it('stays disabled until the page has hydrated, so an early tap is not lost', () => {
    expect(render()).toMatch(/<button[^>]*disabled=""/);
  });
});
