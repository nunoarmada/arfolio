/** Logo URLs and the memory of logos that failed to load (shared by every avatar on the page). */

export function merchantLogoUrl(merchantId: string): string {
  return `/api/merchants/${merchantId}/logo`;
}

/** A logo is requested only when the server says one exists and it did not already fail. */
export function shouldRequestLogo(
  merchant: { id: string; hasLogo: boolean } | null | undefined,
  failed: ReadonlySet<string> = recentFailures(),
): merchant is { id: string; hasLogo: true } {
  return Boolean(merchant?.hasLogo) && !failed.has(merchant!.id);
}

// Module level: virtualised rows remount often and must not request a missing logo again; a
// failure is forgotten after ten minutes, since the logo may have been fetched meanwhile.
const FAILED_TTL_MS = 10 * 60_000;
const failedLogos = new Map<string, number>();

/** The ids whose logo failed less than ten minutes ago. */
function recentFailures(now = Date.now()): ReadonlySet<string> {
  const live = new Set<string>();
  for (const [id, at] of failedLogos) {
    if (now - at < FAILED_TTL_MS) live.add(id);
    else failedLogos.delete(id);
  }
  return live;
}

export function markLogoFailed(merchantId: string, now = Date.now()): void {
  failedLogos.set(merchantId, now);
}

export function hasLogoFailed(merchantId: string, now = Date.now()): boolean {
  return recentFailures(now).has(merchantId);
}

/** Test hook. */
export function resetFailedLogos(): void {
  failedLogos.clear();
}
