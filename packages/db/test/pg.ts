import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { runMigrations } from '../src/index.js';

export const APP_PASSWORD = 'test-app-password';

export interface TestDb {
  ownerUrl: string;
  appUrl: (password: string) => string;
  drop(): Promise<void>;
}

/**
 * Creates a uniquely named, fully migrated database and returns its URLs.
 * Uses DATABASE_URL_TEST (CI) when set, otherwise the throwaway cluster started in global-setup.
 */
export async function startTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL_TEST || inject('clusterUrl');
  if (!adminUrl)
    throw new Error('No test database available: set DATABASE_URL_TEST or run via vitest');

  const name = `pfm_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }

  const withDb = (user?: string, password?: string): string => {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    if (user) url.username = user;
    if (password !== undefined) url.password = password;
    return url.toString();
  };

  const ownerUrl = withDb();
  await runMigrations(ownerUrl, APP_PASSWORD);

  return {
    ownerUrl,
    appUrl: (password) => withDb('pfm_app', password),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`drop database if exists ${name} with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
