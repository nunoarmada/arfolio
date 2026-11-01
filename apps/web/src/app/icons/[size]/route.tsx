import { isIconKind, renderIcon } from '@/lib/brand-icons';

export const dynamic = 'force-dynamic';

/** PWA, Apple touch and badge icons, generated from the brand config (no upload, no remote fetch). */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ size: string }> },
): Promise<Response> {
  const kind = (await ctx.params).size;
  if (!isIconKind(kind)) return new Response(null, { status: 404 });
  return renderIcon(kind);
}
