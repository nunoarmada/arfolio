import { renderOg } from '@/lib/og-image';

export const dynamic = 'force-dynamic';

/** Twitter summary-large-image card, 1200x600. `?lang=` one of the app locales, else the request locale. */
export async function GET(request: Request): Promise<Response> {
  return renderOg(request, 600);
}
