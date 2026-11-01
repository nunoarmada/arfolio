/**
 * Pure helpers for the service worker (src/app/sw.ts). No DOM or worker globals, so they run in
 * vitest and the worker bundle alike.
 */

export interface PushNotificationData {
  title: string;
  body: string;
  tag: string | undefined;
  /** A same-origin path to open on click; validated again with safeNotificationUrl at click time. */
  url: string;
}

/**
 * Shown when a push arrives with no usable payload. The worker cannot read the locale cookie
 * reliably, so the copy is neutral pt-PT and carries no brand name.
 */
export const FALLBACK_NOTIFICATION: PushNotificationData = {
  title: 'Nova notificação',
  body: '',
  tag: undefined,
  url: '/',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parses a push event's text payload defensively: anything unusable yields the generic notification. */
export function parsePushPayload(raw: string | null | undefined): PushNotificationData {
  if (!raw) return FALLBACK_NOTIFICATION;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return FALLBACK_NOTIFICATION;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return FALLBACK_NOTIFICATION;
  }
  const record = data as Record<string, unknown>;
  const title = text(record.title)?.trim();
  return {
    title: title ? title : FALLBACK_NOTIFICATION.title,
    body: text(record.body) ?? '',
    tag: text(record.tag),
    url: text(record.url) ?? '/',
  };
}

/**
 * The absolute URL a notification click may open: only http(s) URLs on this origin qualify.
 * Anything else, including a crafted payload URL, becomes the origin's home page. Resolving with
 * the WHATWG URL parser normalises tricks such as `/\evil.example` and `/<tab>/evil.example`.
 *
 * The result is absolute on purpose: a bare pathname is not safe to resolve a second time,
 * because dot-segments collapse `/.//evil.example` to `//evil.example`, which a later
 * `new URL(path, origin)` reads as another host. Callers must use the value as given.
 */
export function safeNotificationUrl(raw: unknown, origin: string): string {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return '/';
  }
  const home = new URL('/', base).href;
  if (typeof raw !== 'string' || raw === '') return home;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return home;
    if (url.origin !== base.origin) return home;
    return url.href;
  } catch {
    return home;
  }
}

/** The first open window client whose URL is on this origin (the one to focus and navigate). */
export function findSameOriginClient<T extends { url: string }>(
  clients: readonly T[],
  origin: string,
): T | undefined {
  return clients.find((client) => {
    try {
      return new URL(client.url).origin === origin;
    } catch {
      return false;
    }
  });
}
