import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the throwaway cluster, or '' when DATABASE_URL_TEST is used. */
    clusterUrl: string;
  }
}

const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const RUN_AS = process.env.PG_RUN_AS ?? 'postgres';

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

/** Runs a Postgres binary, dropping root privileges because initdb/postgres refuse to run as root. */
function pgRun(bin: string, args: string[]): string {
  const asRoot = process.getuid?.() === 0;
  const [cmd, cmdArgs] = asRoot
    ? ['runuser', ['-u', RUN_AS, '--', join(PG_BIN, bin), ...args]]
    : [join(PG_BIN, bin), args];
  return execFileSync(cmd as string, cmdArgs as string[], { encoding: 'utf8', stdio: 'pipe' });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (process.env.DATABASE_URL_TEST) {
    project.provide('clusterUrl', '');
    return async () => {};
  }

  const asRoot = process.getuid?.() === 0;
  const dir = mkdtempSync(join(tmpdir(), 'pfm-pg-'));
  if (asRoot) {
    chownSync(
      dir,
      Number(execFileSync('id', ['-u', RUN_AS]).toString()),
      Number(execFileSync('id', ['-g', RUN_AS]).toString()),
    );
  }
  chmodSync(dir, 0o700);
  const data = join(dir, 'data');
  const pwFile = join(dir, 'pw');
  const password = randomBytes(12).toString('hex');
  writeFileSync(pwFile, password, { mode: 0o644 });
  const superuser = asRoot ? RUN_AS : (process.env.USER ?? 'postgres');
  const port = await freePort();

  pgRun('initdb', [
    '-D',
    data,
    '-U',
    superuser,
    '--pwfile',
    pwFile,
    '--auth-local=scram-sha-256',
    '--auth-host=scram-sha-256',
    '-E',
    'UTF8',
  ]);
  pgRun('pg_ctl', [
    '-D',
    data,
    '-w',
    '-l',
    join(dir, 'log'),
    '-o',
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir} -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
    'start',
  ]);

  project.provide('clusterUrl', `postgres://${superuser}:${password}@127.0.0.1:${port}/postgres`);

  return async () => {
    try {
      pgRun('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
