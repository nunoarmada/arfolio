export type PushPermission = 'default' | 'granted' | 'denied';

export type PushUiState =
  | 'checking'
  | 'unsupported'
  | 'ios-install'
  | 'default'
  | 'denied'
  | 'granted-unsubscribed'
  | 'subscribed'
  /** Allowed, but the server could not say whether this browser is registered. */
  | 'check-failed';

/** What the browser and the server say about this device. */
export interface PushEnv {
  /** serviceWorker, PushManager and Notification are all there. */
  supported: boolean;
  /** iPhone or iPad (including an iPad that reports itself as a Mac). */
  ios: boolean;
  /** Running as an installed app (home-screen icon), not in a browser tab. */
  installed: boolean;
  permission: PushPermission;
  /**
   * Whether this browser's subscription is in the server's device list: null when the server could
   * not be asked (only relevant once the permission is granted).
   */
  registered: boolean | null;
}

/**
 * The UI state of the "this device" block. iOS outside the installed app comes first: Safari tabs
 * have no push at all, and the useful advice there is to install, not "unsupported".
 */
export function derivePushState(env: PushEnv | null): PushUiState {
  if (!env) return 'checking';
  if (env.ios && !env.installed) return 'ios-install';
  if (!env.supported) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  if (env.permission === 'default') return 'default';
  if (env.registered === null) return 'check-failed';
  return env.registered ? 'subscribed' : 'granted-unsubscribed';
}

/** iPhone, iPod, iPad, and iPadOS Safari, which sends a Macintosh user agent but has a touch screen. */
export function detectIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export function isStandalone(signals: {
  iosStandalone: boolean | undefined;
  displayModeStandalone: boolean;
}): boolean {
  return signals.iosStandalone === true || signals.displayModeStandalone;
}
