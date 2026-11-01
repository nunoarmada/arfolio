import { renderOg } from '@/lib/og-image';

export const dynamic = 'force-dynamic';

/** Open Graph card, 1200x630. `?lang=` one of the app locales, else the request locale. */
export async function GET(request: Request): Promise<Response> {
  return renderOg(request, 630);
}
