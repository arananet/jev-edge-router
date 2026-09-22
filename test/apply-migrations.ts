import { env } from 'cloudflare:test';
import migration from '../migrations/0001_decisions.sql?raw';

/** Applies the D1 migrations to the test database. Call once per suite that touches the log. */
export async function applyMigrations(): Promise<void> {
  const db = (env as unknown as { DB: D1Database }).DB;
  for (const statement of migration.split(';').map((s) => s.trim()).filter((s) => s.length > 0)) {
    await db.prepare(statement).run();
  }
}
