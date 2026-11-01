/**
 * End-to-end runner: migrated database -> production build -> `next start` -> Playwright.
 *
 * Database: DATABASE_URL_TEST (CI) or a throwaway local cluster (same helper the vitest suites
 * use). Skip the build with E2E_SKIP_BUILD=1 when `.next` is already current.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../../../packages/db/src/index.js';
import startCluster from '../../../packages/db/test/global-setup';
import { FAKE_T212, startFakeEnableBanking, startFakeTrading212, type FakeServer } from './fakes';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const APP_PASSWORD = 'e2e-app-password';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): number {
  const res = spawnSync(cmd, args, { cwd: webDir, env, stdio: 'inherit' });
  return res.status ?? 1;
}

/** Like `run`, but keeps this process's event loop alive: the fake provider servers live in it. */
function runAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: webDir, env, stdio: 'inherit' });
    // Ctrl-C and `kill` reach the test run too, so nothing is left running behind the runner.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const done = (code: number) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code);
    };
    child.once('error', () => done(1));
    child.once('exit', (code) => done(code ?? 1));
  });
}

async function waitFor(url: string, server: ChildProcess, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('next start exited before becoming ready');
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main(): Promise<number> {
  let clusterUrl = '';
  const stopCluster = await startCluster({
    provide: (_key: string, value: string) => {
      clusterUrl = value;
    },
  } as never);
  const adminUrl = process.env.DATABASE_URL_TEST || clusterUrl;
  const dbName = `pfm_e2e_${randomBytes(6).toString('hex')}`;
  const withDb = (user?: string, password?: string): string => {
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    if (user) url.username = user;
    if (password !== undefined) url.password = password;
    return url.toString();
  };

  let server: ChildProcess | undefined;
  let serverNoAi: ChildProcess | undefined;
  let stateFile = '';
  const fakes: FakeServer[] = [];
  try {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    await admin.end();
    await runMigrations(withDb(), APP_PASSWORD);

    // Fake providers on loopback; the Enable Banking key pair exists only for this run.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bankAppId = 'e2e-app-id';
    const fakeBank = await startFakeEnableBanking({
      appId: bankAppId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const fakeBroker = await startFakeTrading212();
    fakes.push(fakeBank, fakeBroker);

    const port = await freePort();
    const baseUrl = `http://localhost:${port}`;
    const setupToken = randomBytes(18).toString('hex');
    stateFile = join(tmpdir(), `pfm-e2e-${randomBytes(6).toString('hex')}.json`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: withDb('pfm_app', APP_PASSWORD),
      BETTER_AUTH_SECRET: randomBytes(24).toString('hex'),
      BETTER_AUTH_URL: baseUrl,
      APP_URL: baseUrl,
      SETUP_TOKEN: setupToken,
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ENABLE_BANKING_APP_ID: bankAppId,
      ENABLE_BANKING_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ENABLE_BANKING_API_URL: fakeBank.url,
      TRADING212_API_URL: `${fakeBroker.url}/api/v0`,
      // Makes the AI switch available; nothing here ever calls Anthropic (the worker is not run).
      ANTHROPIC_API_KEY: 'sk-ant-e2e-not-a-real-key',
      E2E_DATABASE_URL: withDb(),
      E2E_T212_KEY: FAKE_T212.key,
      E2E_T212_SECRET: FAKE_T212.secret,
      BRAND_NAME: 'Casa Exemplo',
      BRAND_PRIMARY_COLOR: '#2F5BC2',
      DEFAULT_LOCALE: 'pt-PT',
      E2E_BASE_URL: baseUrl,
      E2E_SETUP_TOKEN: setupToken,
      E2E_STATE_FILE: stateFile,
    };

    if (!process.env.E2E_SKIP_BUILD) {
      const code = run('pnpm', ['exec', 'next', 'build', '--webpack'], env);
      if (code !== 0) return code;
    }

    server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
      cwd: webDir,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitFor(`${baseUrl}/api/health`, server);

    // A second instance of the same build without an Anthropic key, to see the "AI unavailable"
    // settings state. It shares the database and the auth secret, so the owner's session works.
    const portNoAi = await freePort();
    serverNoAi = spawn('pnpm', ['exec', 'next', 'start', '-p', String(portNoAi)], {
      cwd: webDir,
      env: { ...env, PORT: String(portNoAi), ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitFor(`http://localhost:${portNoAi}/api/health`, serverNoAi);
    env.E2E_NOAI_URL = `http://localhost:${portNoAi}`;
    return await runAsync('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], env);
  } finally {
    server?.kill('SIGTERM');
    serverNoAi?.kill('SIGTERM');
    await Promise.all(fakes.map((f) => f.close()));
    if (stateFile) rmSync(stateFile, { force: true });
    const cleanup = new pg.Client({ connectionString: adminUrl });
    try {
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${dbName} with (force)`);
    } catch (error) {
      console.error(`e2e cleanup: could not drop ${dbName}: ${(error as Error).message}`);
    } finally {
      await cleanup.end().catch(() => {});
    }
    await stopCluster();
  }
}

process.exitCode = await main();
