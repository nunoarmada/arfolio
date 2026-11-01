/**
 * Set by a successful "generate" action so the pending heading that replaces the button takes
 * focus once (the button is gone, so focus would fall back to the page). A plain load never sets
 * it, so a pending report opened from a link does not steal focus.
 */
export const focusPendingHeading = { next: false };
