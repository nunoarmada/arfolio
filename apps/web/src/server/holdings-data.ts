import { listHoldings, NotFoundError, type Holdings, type ServiceCtx } from '@arfolio/services';
import { decimalToMinor } from '../lib/holdings-format';

/** Every amount the page will format has to be a safe integer in minor units, or it cannot render. */
function renderable(holdings: Holdings): boolean {
  const currency = holdings.currency ?? 'EUR';
  const safe = (value: string | null, code: string) =>
    value === null || Number.isSafeInteger(decimalToMinor(value, code));
  return (
    safe(holdings.total, currency) &&
    holdings.items.every(
      (h) => safe(h.value, h.currency) && safe(h.cost, h.currency) && safe(h.profit, h.currency),
    )
  );
}

/** The account's holdings, or `null` when they could not be loaded (the section fails alone). */
export async function loadHoldings(ctx: ServiceCtx, accountId: string): Promise<Holdings | null> {
  try {
    const holdings = await listHoldings(ctx, accountId);
    if (!renderable(holdings)) {
      console.error('holdings failed: amount out of range');
      return null;
    }
    return holdings;
  } catch (error) {
    // A missing account is not a holdings failure: the page answers 404 itself (and a deleted
    // account's page is re-rendered once by the delete action before the redirect).
    if (error instanceof NotFoundError) return null;
    // The type only: messages can carry provider text or fragments of credentials.
    console.error(`holdings failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    return null;
  }
}
