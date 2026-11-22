import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import { ColumnMapper, type EditableMapping } from './column-mapper';

const file = {
  kind: 'csv' as const,
  headers: ['Date', 'Description', 'Amount'],
  headerRow: 0,
  samples: [['2026-03-01', 'Mercado Central', '12.50']],
};

const render = (mapping: EditableMapping) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ColumnMapper file={file as never} mapping={mapping} onChange={() => undefined} />
    </NextIntlClientProvider>,
  );

const invertBox = (html: string) =>
  /<label[^>]*>\s*<input[^>]*type="checkbox"[^>]*>(?:(?!<\/label>).)*Reverse the sign/s.exec(
    html,
  )?.[0];

describe('ColumnMapper', () => {
  // A card statement lists purchases as positive amounts; without this the card owes nothing.
  it('offers to reverse the sign of the amounts, unchecked by default', () => {
    const box = invertBox(render({ headerRow: 0, dateFormat: 'auto' }));
    expect(box).toBeDefined();
    expect(box).not.toContain('checked=""');
  });

  it('shows the sign as reversed when the mapping says so', () => {
    const box = invertBox(render({ headerRow: 0, dateFormat: 'auto', invertSign: true }));
    expect(box).toContain('checked=""');
  });
});
