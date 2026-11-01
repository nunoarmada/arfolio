import { describe, expect, it } from 'vitest';
import { oauthRedirectUrl, oauthSearch } from './oauth-continue';

describe('oauthRedirectUrl', () => {
  it('returns the URL of an OAuth continuation response', () => {
    expect(oauthRedirectUrl({ redirect: true, url: 'https://claude.ai/cb?code=1' })).toBe(
      'https://claude.ai/cb?code=1',
    );
  });

  it('ignores an ordinary sign-in response', () => {
    expect(oauthRedirectUrl({ redirect: false, token: 't', user: {} })).toBeNull();
    expect(oauthRedirectUrl({ redirect: false, url: 'https://x.example' })).toBeNull();
    expect(oauthRedirectUrl({ redirect: true })).toBeNull();
    expect(oauthRedirectUrl(null)).toBeNull();
    expect(oauthRedirectUrl(undefined)).toBeNull();
  });
});

describe('oauthSearch', () => {
  it('keeps the query only when it carries a signed OAuth request', () => {
    expect(oauthSearch('?client_id=abc&scope=pfm%3Aread&exp=1&sig=zzz')).toBe(
      '?client_id=abc&scope=pfm%3Aread&exp=1&sig=zzz',
    );
  });

  it('drops anything else, so normal sign-ins are unchanged', () => {
    expect(oauthSearch('?next=%2Fbudget')).toBe('');
    expect(oauthSearch('')).toBe('');
  });
});
