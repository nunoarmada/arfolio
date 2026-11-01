import { MAX_IMPORT_BYTES as SERVER_LIMIT } from '@arfolio/services';
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES } from './import-limits';

describe('import limits', () => {
  it('match the services limit', () => {
    expect(MAX_IMPORT_BYTES).toBe(SERVER_LIMIT);
  });
});
