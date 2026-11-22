import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/index.js';
import { readWorkbookStream } from '../../src/import/xls.js';
import { buildCfb } from './xls-builder.js';

const INVALID = 'The file is not a valid XLS workbook';

const patterned = (length: number) => Buffer.from(Array.from({ length }, (_, i) => (i * 7) % 251));

function expectInvalid(run: () => unknown, message = INVALID): void {
  expect(run).toThrow(ValidationError);
  expect(run).toThrow(message);
}

describe('readWorkbookStream', () => {
  it('returns the Workbook stream of a regular compound file', () => {
    const payload = patterned(5000);
    expect(readWorkbookStream(buildCfb(payload)).equals(payload)).toBe(true);
  });

  it('reads a workbook stored in the mini stream', () => {
    const payload = patterned(300);
    expect(readWorkbookStream(buildCfb(payload, { mini: true })).equals(payload)).toBe(true);
  });

  it('accepts the legacy stream name Book', () => {
    const payload = patterned(5000);
    expect(readWorkbookStream(buildCfb(payload, { name: 'Book' })).equals(payload)).toBe(true);
  });

  it('rejects a file without the compound signature', () => {
    expectInvalid(() => readWorkbookStream(Buffer.alloc(2048, 0x41)));
  });

  it('rejects a truncated file', () => {
    expectInvalid(() => readWorkbookStream(buildCfb(patterned(5000)).subarray(0, 600)));
  });

  it('rejects a looping sector chain', () => {
    const file = buildCfb(patterned(5000), { fatPatch: (fat) => (fat[0] = 0) });
    expectInvalid(() => readWorkbookStream(file));
  });

  it('rejects a chain pointing outside the file', () => {
    const file = buildCfb(patterned(5000), { fatPatch: (fat) => (fat[0] = 9000) });
    expectInvalid(() => readWorkbookStream(file));
  });

  it('rejects a compound file without a workbook stream', () => {
    expectInvalid(() => readWorkbookStream(buildCfb(patterned(5000), { name: 'Other' })));
  });
});
