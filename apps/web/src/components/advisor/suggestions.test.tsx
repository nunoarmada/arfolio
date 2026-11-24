import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import { pickSuggestions } from '@/server/advisor-data';
import { Suggestions } from './suggestions';

const learning = { ready: false, completeMonths: 0, required: 3 };
const ready = { ready: true, completeMonths: 6, required: 3 };

const LABELS = messages.advisor.suggestions;

function render(keys: ReturnType<typeof pickSuggestions>) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Suggestions keys={keys} onPick={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('Suggestions', () => {
  it.each([
    ['still learning', { learning, hasEmergencyFund: false, goalsCount: 0 }],
    ['no emergency fund', { learning: ready, hasEmergencyFund: false, goalsCount: 2 }],
    ['an emergency fund and goals', { learning: ready, hasEmergencyFund: true, goalsCount: 1 }],
    ['an emergency fund and no goals', { learning: ready, hasEmergencyFund: true, goalsCount: 0 }],
  ])('renders exactly the three chips pickSuggestions chose (%s)', (_name, input) => {
    const keys = pickSuggestions(input);
    const html = render(keys);
    expect(html.match(/<button/g)).toHaveLength(3);
    for (const key of keys) expect(html).toContain(LABELS[key]);
  });

  it('is a labelled group', () => {
    const html = render(['howThisMonth', 'whereSave', 'setGoal']);
    expect(html).toContain('role="group"');
    expect(html).toContain(`aria-label="${LABELS.label}"`);
  });

  it('can be disabled while the advisor is answering', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Suggestions keys={['howThisMonth', 'whereSave', 'setGoal']} onPick={() => {}} disabled />
      </NextIntlClientProvider>,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});
