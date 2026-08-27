import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pool } from './client.js';
import { config } from '../config.js';

/**
 * Minimal forward-only migration runner: apply migrations/*.sql in filename
 * order, record each in schema_migrations. Advisory lock guards against
 * concurrent backend instances migrating at once.
 */
export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(420001)');
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);

    const files = (await readdir(config.migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(config.migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${String(err)}`);
      }
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock(420001)').catch(() => {});
    client.release();
  }
}
