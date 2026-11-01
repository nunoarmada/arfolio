// Fail fast: validate the environment when the server boots, not on the first request.
// `next build` does not call register(), so building without runtime env still works.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getEnv } = await import('./lib/env');
    getEnv();
  }
}
