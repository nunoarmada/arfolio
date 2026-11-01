type Level = 'info' | 'warn' | 'error';

/** One JSON object per line on stdout/stderr. Callers pass messages only, never env values. */
function write(level: Level, msg: string): void {
  const line = JSON.stringify({ level, msg, time: new Date().toISOString() });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
};

/** Message-only rendering of an unknown error: raw error objects may carry query text or params. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
