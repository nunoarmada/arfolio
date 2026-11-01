import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, ensureAppRole, runMigrations } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

describe('migrations and roles', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it('is idempotent when run twice', async () => {
    await expect(runMigrations(testDb.ownerUrl, APP_PASSWORD)).resolves.toBeUndefined();
    await expect(runMigrations(testDb.ownerUrl, APP_PASSWORD)).resolves.toBeUndefined();
  });

  it('updates the pfm_app password on every run', async () => {
    await runMigrations(testDb.ownerUrl, 'rotated-password');
    const client = new pg.Client({ connectionString: testDb.appUrl('rotated-password') });
    await client.connect();
    await client.end();
    await runMigrations(testDb.ownerUrl, APP_PASSWORD);
  });

  it('does not let pfm_app create tables', async () => {
    const client = new pg.Client({ connectionString: testDb.appUrl(APP_PASSWORD) });
    await client.connect();
    try {
      await expect(client.query('create table evil (id int)')).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.end();
    }
  });

  it('lets pfm_app use system_status, which has no RLS', async () => {
    const client = new pg.Client({ connectionString: testDb.appUrl(APP_PASSWORD) });
    await client.connect();
    try {
      await client.query(`insert into system_status (key, value) values ('hb', '{"ok":true}')`);
      const { rows } = await client.query('select key from system_status');
      expect(rows).toEqual([{ key: 'hb' }]);
    } finally {
      await client.end();
    }
  });

  it('grants pfm_app access to objects later created in the pgboss schema', async () => {
    const owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    try {
      await owner.query('create table pgboss.later_probe (id int primary key)');
    } finally {
      await owner.end();
    }

    const app = new pg.Client({ connectionString: testDb.appUrl(APP_PASSWORD) });
    await app.connect();
    try {
      await app.query('insert into pgboss.later_probe (id) values (1)');
      const { rows } = await app.query('select id from pgboss.later_probe');
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await app.end();
    }
  });

  it('pins pfm_app attributes, correcting a pre-existing bypassrls role', async () => {
    const owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    try {
      await owner.query('alter role pfm_app bypassrls');
      await runMigrations(testDb.ownerUrl, APP_PASSWORD);
      const { rows } = await owner.query(
        `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
         from pg_roles where rolname = 'pfm_app'`,
      );
      expect(rows).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
          rolcanlogin: true,
        },
      ]);
    } finally {
      await owner.end();
    }
  });

  it('stores a SCRAM verifier, never the plaintext password', async () => {
    const owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ rolpassword: string }>(
        `select rolpassword from pg_authid where rolname = 'pfm_app'`,
      );
      expect(rows[0]?.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
      expect(rows[0]?.rolpassword).not.toContain(APP_PASSWORD);
    } finally {
      await owner.end();
    }
    const app = new pg.Client({ connectionString: testDb.appUrl(APP_PASSWORD) });
    await app.connect();
    await app.end();
  });

  it('does not leak the password in the error when the role statement fails', async () => {
    const canary = 'canary-secret-9f3a';
    const limited = `limited_${Math.random().toString(16).slice(2, 10)}`;
    const owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    try {
      await owner.query(`create role ${limited} login password 'x'`);
      await owner.query(`grant usage on schema public to ${limited}`);
      const url = new URL(testDb.ownerUrl);
      url.username = limited;
      url.password = 'x';
      const { db, pool } = createDb(url.toString(), { max: 1 });
      try {
        const err = await ensureAppRole(db, canary).then(
          () => null,
          (e: unknown) => e as Error,
        );
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toMatch(/failed to alter role pfm_app/);
        expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(canary);
        expect(err?.cause).toBeUndefined();
      } finally {
        await pool.end();
      }
    } finally {
      await owner.query(`drop owned by ${limited}`);
      await owner.query(`drop role ${limited}`);
      await owner.end();
    }
  });
});
