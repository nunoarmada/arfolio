import { describe, expect, it } from 'vitest';
import { isAllowedMcpRedirectUri, parseExtraRedirectUris } from './mcp-redirect';

describe('isAllowedMcpRedirectUri', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'http://localhost:53124/callback',
    'http://127.0.0.1:8123/callback',
  ])('allows %s', (uri) => {
    expect(isAllowedMcpRedirectUri(uri)).toBe(true);
  });

  it.each([
    'https://evil.example/cb',
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'https://user@claude.ai/api/mcp/auth_callback',
    'https://claude.ai:8443/api/mcp/auth_callback',
    'http://localhost/callback',
    'http://localhost:53124/other',
    'http://localhost:53124/callback?x=1',
    'http://localhost.evil.example:80/callback',
    'https://localhost:53124/callback',
    'http://[::1]:53124/callback',
    'not a url',
    '',
  ])('rejects %s', (uri) => {
    expect(isAllowedMcpRedirectUri(uri)).toBe(false);
  });

  it('allows operator-configured exact URIs only', () => {
    const extra = ['https://app.example.org/oauth/cb'];
    expect(isAllowedMcpRedirectUri('https://app.example.org/oauth/cb', extra)).toBe(true);
    expect(isAllowedMcpRedirectUri('https://app.example.org/oauth/cb/', extra)).toBe(false);
    expect(isAllowedMcpRedirectUri('https://app.example.org/other', extra)).toBe(false);
  });
});

describe('parseExtraRedirectUris', () => {
  it('splits on commas, trims and drops blanks', () => {
    expect(parseExtraRedirectUris(' https://a.example/cb , ,https://b.example/cb ')).toEqual([
      'https://a.example/cb',
      'https://b.example/cb',
    ]);
  });
  it('treats undefined as none', () => {
    expect(parseExtraRedirectUris(undefined)).toEqual([]);
  });
});
