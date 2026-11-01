import { describe, expect, it } from 'vitest';
import { derivePushState, detectIos, isStandalone, type PushEnv } from './push-state';

const base: PushEnv = {
  supported: true,
  ios: false,
  installed: false,
  permission: 'default',
  registered: false,
};

describe('derivePushState', () => {
  it('is checking until the browser has been inspected', () => {
    expect(derivePushState(null)).toBe('checking');
  });

  it('is unsupported when the browser lacks service workers, push or notifications', () => {
    expect(derivePushState({ ...base, supported: false })).toBe('unsupported');
  });

  it('asks an iPhone or iPad tab to be added to the home screen first, whatever the API says', () => {
    expect(derivePushState({ ...base, ios: true, supported: false })).toBe('ios-install');
    expect(derivePushState({ ...base, ios: true, supported: true })).toBe('ios-install');
    expect(derivePushState({ ...base, ios: true, permission: 'denied' })).toBe('ios-install');
  });

  it('treats an installed iOS app like any other browser', () => {
    expect(derivePushState({ ...base, ios: true, installed: true })).toBe('default');
    expect(derivePushState({ ...base, ios: true, installed: true, supported: false })).toBe(
      'unsupported',
    );
  });

  it('is default while the permission has not been asked', () => {
    expect(derivePushState(base)).toBe('default');
  });

  it('is denied when the permission was refused, even with a stale registration', () => {
    expect(derivePushState({ ...base, permission: 'denied' })).toBe('denied');
    expect(derivePushState({ ...base, permission: 'denied', registered: true })).toBe('denied');
  });

  it('is granted-unsubscribed when allowed but this browser is not in the server list', () => {
    expect(derivePushState({ ...base, permission: 'granted', registered: false })).toBe(
      'granted-unsubscribed',
    );
  });

  it('is subscribed when allowed and this browser is in the server list', () => {
    expect(derivePushState({ ...base, permission: 'granted', registered: true })).toBe(
      'subscribed',
    );
  });

  it('is check-failed when the server could not say whether this browser is registered', () => {
    expect(derivePushState({ ...base, permission: 'granted', registered: null })).toBe(
      'check-failed',
    );
  });
});

describe('detectIos', () => {
  it('recognises iPhone, iPad and iPod', () => {
    expect(detectIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5)).toBe(true);
    expect(detectIos('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 5)).toBe(true);
  });
  it('recognises an iPad that reports a Mac, by its touch points', () => {
    expect(detectIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(detectIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
  });
  it('is false elsewhere', () => {
    expect(detectIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5)).toBe(false);
    expect(detectIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0)).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true for the iOS flag or the display-mode media query', () => {
    expect(isStandalone({ iosStandalone: true, displayModeStandalone: false })).toBe(true);
    expect(isStandalone({ iosStandalone: undefined, displayModeStandalone: true })).toBe(true);
  });
  it('is false in a browser tab', () => {
    expect(isStandalone({ iosStandalone: undefined, displayModeStandalone: false })).toBe(false);
    expect(isStandalone({ iosStandalone: false, displayModeStandalone: false })).toBe(false);
  });
});
