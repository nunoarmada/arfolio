import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './brand-mark';

describe('BrandMark', () => {
  it('draws the tile from the theme-invariant tile tokens, not the dark-mode primary', () => {
    const html = renderToStaticMarkup(
      <BrandMark brand={{ name: 'Arfolio', logoUrl: undefined }} />,
    );
    expect(html).toContain('var(--brand-tile)');
    expect(html).toContain('var(--brand-tile-2)');
    expect(html).toContain('var(--brand-tile-foreground)');
    expect(html).not.toContain('text-primary-foreground');
    expect(html).not.toContain('--brand-gradient');
  });

  it('shows the logo instead of the tile when one is set', () => {
    const html = renderToStaticMarkup(
      <BrandMark brand={{ name: 'Casa', logoUrl: 'https://example.com/logo.png' }} />,
    );
    expect(html).toContain('https://example.com/logo.png');
    expect(html).not.toContain('--brand-tile');
  });
});
