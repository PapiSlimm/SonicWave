/**
 * Boot-time migration runner (2026-09). Runs every migrations/*.sql exactly
 * once, in filename order, tracked in schema_migrations. All files are
 * idempotent (CREATE ... IF NOT EXISTS), so a re-run is always safe.
 * Loud on failure: names the file and the Postgres error, never swallows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./pg.ts";
import { logger } from "../lib/logger.ts";

export async function runMigrations(db: Db, dir = "migrations"): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const applied = new Set(
    (await db.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(r => r.filename)
  );
  const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    logger.info({ file: f }, "migration: applying");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [f]);
      logger.info({ file: f }, "migration: applied");
    } catch (e: any) {
      logger.error({ file: f, err: e?.message }, "migration: FAILED");
      throw e;
    }
  }
}
