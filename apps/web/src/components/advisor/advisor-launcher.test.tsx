import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { AdvisorProvider } from './advisor-context';
import { AdvisorLauncher } from './advisor-launcher';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

function render(opts: { available: boolean; unreadProactive?: boolean }) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdvisorProvider
        available={opts.available}
        unreadProactive={opts.unreadProactive ?? false}
        canApply
        isOwner
        brandName="Acme"
      >
        <AdvisorLauncher />
      </AdvisorProvider>
    </NextIntlClientProvider>,
  );
}

describe('AdvisorLauncher', () => {
  it('is not rendered when the advisor is not available', () => {
    expect(render({ available: false })).toBe('');
    expect(render({ available: false, unreadProactive: true })).toBe('');
  });

  it('is a 56 px labelled button that controls the window', () => {
    const html = render({ available: true });
    expect(html).toContain('aria-label="Open advisor"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="advisor-window"');
    expect(html).toMatch(/<button[^>]*class="[^"]*size-14/);
    expect(html).not.toContain('data-unread');
  });

  it('shows the unread dot and names it', () => {
    const html = render({ available: true, unreadProactive: true });
    expect(html).toContain('aria-label="Open advisor, new message"');
    expect(html).toContain('data-unread');
  });
});
