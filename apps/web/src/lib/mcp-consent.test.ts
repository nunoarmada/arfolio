import { describe, expect, it } from 'vitest';
import { grantableScopes } from './mcp-consent';

const ALL = ['openid', 'profile', 'email', 'offline_access', 'pfm:read', 'pfm:write'];

describe('grantableScopes', () => {
  it('keeps everything requested for owners and members', () => {
    expect(grantableScopes(ALL, 'owner')).toEqual(ALL);
    expect(grantableScopes(ALL, 'member')).toEqual(ALL);
  });

  it('drops pfm:write for a viewer and keeps the rest in order', () => {
    expect(grantableScopes(ALL, 'viewer')).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'pfm:read',
    ]);
  });

  it('drops pfm:write for a role it does not know (fail closed)', () => {
    expect(grantableScopes(['pfm:read', 'pfm:write'], 'guest')).toEqual(['pfm:read']);
  });
});
