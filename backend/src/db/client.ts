import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, params);
}

/** Wait for Postgres to accept connections (compose startup race). */
export async function waitForDb(attempts = 30, delayMs = 1000): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Postgres not reachable after ${attempts} attempts: ${String(lastErr)}`);
}
