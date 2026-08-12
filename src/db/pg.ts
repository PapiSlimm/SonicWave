/**
 * PostgreSQL data layer — replaces the ephemeral SQLite singleton in db.ts.
 *
 * - Pooled `pg` connection (multi-instance safe; durable).
 * - Parameterized queries (SQL-injection safe, as before).
 * - Optimistic concurrency on project state (the original blindly overwrote,
 *   losing concurrent edits).
 *
 * `pg` is imported lazily so the pure modules/tests don't require it.
 */
import type { Pool as PgPool } from "pg";

export interface Db {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  ping(): Promise<void>;
  end(): Promise<void>;
}

export async function createDb(databaseUrl: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool: PgPool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    // In production require real TLS (do NOT use rejectUnauthorized:false).
    ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: true },
  });
  return {
    query: (text, params) => pool.query(text, params as any[]) as any,
    ping: async () => {
      await pool.query("SELECT 1");
    },
    end: () => pool.end(),
  };
}

/**
 * Apply a project state patch with optimistic concurrency.
 * Rejects with a 409-style error when the client's base version is stale, so two
 * concurrent editors can't silently clobber each other.
 */
export async function applyStatePatch(
  db: Db,
  projectId: string,
  expectedVersion: number,
  nextState: unknown,
): Promise<{ version: number }> {
  const { rows } = await db.query<{ version: number }>(
    `UPDATE project_states
       SET state = $1::jsonb, version = version + 1, updated_at = now()
     WHERE project_id = $2 AND version = $3
     RETURNING version`,
    [JSON.stringify(nextState), projectId, expectedVersion],
  );
  if (rows.length === 0) {
    const err = new Error("Version conflict — reload and retry") as Error & { code: string };
    err.code = "VERSION_CONFLICT";
    throw err;
  }
  return { version: rows[0]!.version };
}

// ---- Dependency adapters for the injected modules ----

export function makeWebhookStore(db: Db) {
  return {
    alreadyProcessed: async (eventId: string) => {
      const { rows } = await db.query("SELECT 1 FROM processed_webhooks WHERE event_id = $1", [eventId]);
      return rows.length > 0;
    },
    markProcessed: async (eventId: string, type: string) => {
      await db.query(
        "INSERT INTO processed_webhooks (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [eventId, type],
      );
    },
    setEntitlement: async (
      uid: string,
      plan: string,
      opts: { subscriptionId?: string; currentPeriodEnd?: number },
    ) => {
      await db.query(
        `INSERT INTO entitlements (user_id, plan, subscription_id, current_period_end, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
           SET plan = EXCLUDED.plan,
               subscription_id = EXCLUDED.subscription_id,
               current_period_end = EXCLUDED.current_period_end,
               updated_at = now()`,
        [uid, plan, opts.subscriptionId ?? null, opts.currentPeriodEnd ?? null],
      );
    },
    resolveUid: async (args: { customerId?: string; clientReferenceId?: string | null }) => {
      if (args.clientReferenceId) return args.clientReferenceId;
      if (!args.customerId) return null;
      const { rows } = await db.query<{ user_id: string }>(
        "SELECT user_id FROM entitlements WHERE stripe_customer_id = $1",
        [args.customerId],
      );
      return rows[0]?.user_id ?? null;
    },
  };
}

export function makeProjectAuthz(db: Db) {
  return {
    getProjectOwner: async (projectId: string) => {
      const { rows } = await db.query<{ user_id: string }>(
        "SELECT user_id FROM projects WHERE id = $1",
        [projectId],
      );
      return rows[0]?.user_id ?? null;
    },
    isCollaborator: async (projectId: string, uid: string) => {
      const { rows } = await db.query(
        "SELECT 1 FROM project_collaborators WHERE project_id = $1 AND user_id = $2",
        [projectId, uid],
      );
      return rows.length > 0;
    },
  };
}
