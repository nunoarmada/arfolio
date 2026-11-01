import { readFileSync, writeFileSync } from 'node:fs';

/**
 * State handed from one spec file to the next (the household is created once, by the
 * foundation spec). The runner points E2E_STATE_FILE at a throwaway file.
 */
const file = process.env.E2E_STATE_FILE;

export interface E2eState {
  /** The owner's TOTP secret, set when two-step verification was enrolled. */
  totpSecret?: string;
}

export function saveState(patch: E2eState): void {
  if (!file) throw new Error('E2E_STATE_FILE is not set (run through e2e/run.ts)');
  writeFileSync(file, JSON.stringify({ ...loadState(), ...patch }));
}

export function loadState(): E2eState {
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as E2eState;
  } catch {
    return {};
  }
}
