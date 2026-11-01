import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { schema, withHousehold } from '@arfolio/db';
import { getDb } from '@/lib/db';
import { getSessionContext } from '@/server/session';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/x-icon', 'image/jpeg', 'image/webp']);

const notFound = () =>
  new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });

/**
 * A merchant's logo for a signed-in member of its household. Read through RLS, so another
 * household's merchant is a plain 404. The bytes were verified when stored; the headers keep a
 * browser from ever treating them as anything but a passive image.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSessionContext(request.headers);
  if (!session) {
    return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const { merchantLogo } = schema;
  const [logo] = await withHousehold(getDb(), session.householdId, (tx) =>
    tx
      .select({ contentType: merchantLogo.contentType, bytes: merchantLogo.bytes })
      .from(merchantLogo)
      .where(
        and(
          eq(merchantLogo.merchantId, id),
          eq(merchantLogo.householdId, session.householdId),
          eq(merchantLogo.status, 'ok'),
        ),
      ),
  );
  if (!logo?.bytes || !logo.contentType || !IMAGE_TYPES.has(logo.contentType)) return notFound();

  return new Response(new Uint8Array(logo.bytes), {
    status: 200,
    headers: {
      'Content-Type': logo.contentType,
      'Content-Length': String(logo.bytes.length),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
