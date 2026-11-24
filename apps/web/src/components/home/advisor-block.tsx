import type { ServiceCtx } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { getBrand } from '@/lib/brand';
import { loadAdvisorState } from '@/server/advisor-data';
import { BlockError } from './block-frame';
import { AdvisorHomeCard } from './advisor-home-card';

/** The Home card for the advisor; nothing at all when the advisor is unavailable. */
export async function AdvisorBlock({ ctx }: { ctx: ServiceCtx }) {
  const [t, home, brand] = await Promise.all([
    getTranslations('advisor'),
    getTranslations('home'),
    Promise.resolve(getBrand()),
  ]);
  const title = t('title', { brand: brand.name });
  let state;
  try {
    state = await loadAdvisorState(ctx);
  } catch (error) {
    // The type only: the advisor's data is private.
    console.error(`advisor home card failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return (
      <BlockError
        titleId="home-advisor-title"
        title={title}
        message={t('home.error')}
        retry={home('retry')}
        className="min-h-[148px]"
      />
    );
  }
  if (!state.available) return null;
  const last = state.messages.findLast(
    (m) => m.role === 'assistant' && m.status === 'complete' && m.text !== '',
  );
  return (
    <AdvisorHomeCard
      title={title}
      last={last ? { text: last.text, createdAt: last.createdAt } : null}
      suggestions={state.suggestions}
    />
  );
}
