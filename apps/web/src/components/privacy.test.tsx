import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PrivacyProvider, useFormatMoney } from './privacy';

vi.mock('@/app/actions/privacy', () => ({ setPrivacyAction: vi.fn() }));

function Probe() {
  const formatMoney = useFormatMoney();
  return <span>{formatMoney(123456, 'EUR', 'pt-PT')}</span>;
}

const render = (hidden: boolean) =>
  renderToStaticMarkup(
    <PrivacyProvider initialHidden={hidden}>
      <Probe />
    </PrivacyProvider>,
  ).replace(/\s/g, ' ');

describe('useFormatMoney', () => {
  it('masks amounts when privacy mode is on', () => {
    const html = render(true);
    expect(html).toContain('••••');
    expect(html).not.toMatch(/\d/);
  });

  it('shows amounts when privacy mode is off', () => {
    expect(render(false)).toContain('1 234,56');
  });

  it('refuses to run outside the provider', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/PrivacyProvider/);
  });
});
