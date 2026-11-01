'use client';

// Webpack's runtime exposes the CSP nonce through this free variable (it is `__webpack_require__.nc`).
// Libraries that inject <style> tags at runtime (Radix's scroll lock for menus and dialogs) read it
// so the tag carries the nonce instead of being blocked by `style-src`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- assigned below; webpack rewrites it
declare let __webpack_nonce__: string | undefined;

let applied = false;

/**
 * Only the FIRST nonce counts: the document's CSP header carries the nonce of the request that
 * loaded it, while later soft refreshes render the layout again with a new, unrelated nonce.
 */
export function CspNonce({ nonce }: { nonce: string | undefined }) {
  if (!applied && typeof window !== 'undefined' && nonce) {
    __webpack_nonce__ = nonce;
    applied = true;
  }
  return null;
}
