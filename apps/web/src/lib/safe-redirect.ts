/**
 * Returns `next` only when it resolves to a same-origin path; anything else falls back.
 * Browsers strip tabs and newlines inside URLs, so `/\t/evil.com` would become `//evil.com`:
 * the value is parsed the way a browser would and its origin checked, and control characters
 * (raw or percent-encoded) are refused outright.
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//')) return fallback;
  try {
    const url = new URL(next, 'http://x');
    if (url.origin !== 'http://x') return fallback;
    // Dot segments can collapse into a protocol-relative path ("/.//evil.com" -> "//evil.com").
    if (url.pathname.startsWith('//') || url.pathname.includes('\\')) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
