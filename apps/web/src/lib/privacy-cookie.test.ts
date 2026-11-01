import { describe, expect, it } from 'vitest';
import { parsePrivacy } from './privacy-cookie';

describe('parsePrivacy', () => {
  it('reads "on" as hidden', () => {
    expect(parsePrivacy('on')).toBe(true);
  });

  it('treats off, missing and garbage values as visible', () => {
    expect(parsePrivacy('off')).toBe(false);
    expect(parsePrivacy(undefined)).toBe(false);
    expect(parsePrivacy('garbage')).toBe(false);
  });
});
