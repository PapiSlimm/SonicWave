/**
 * Real readiness/liveness checks.
 *
 * The original `/api/health` returned a static `{status:"ok"}` that never
 * touched the DB or Redis, so a readiness probe could never fail and a broken
 * dependency still routed traffic. Here `/health/ready` actually pings its
 * dependencies and returns 503 when any is down.
 *
 * Dependencies are injected so this is unit-testable without live services.
 */
export interface HealthDeps {
  pingDb: () => Promise<void>;
  pingRedis: () => Promise<void>;
}

export interface ReadyResult {
  status: number; // 200 ready, 503 not ready
  body: {
    ready: boolean;
    checks: Record<string, "ok" | "fail">;
  };
}

export async function checkReady(deps: HealthDeps): Promise<ReadyResult> {
  const checks: Record<string, "ok" | "fail"> = {};

  const results = await Promise.allSettled([
    deps.pingDb().then(() => (checks.database = "ok")),
    deps.pingRedis().then(() => (checks.redis = "ok")),
  ]);
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      checks[i === 0 ? "database" : "redis"] = "fail";
    }
  });

  const ready = Object.values(checks).every((v) => v === "ok");
  return { status: ready ? 200 : 503, body: { ready, checks } };
}

/** Liveness is intentionally cheap: is the event loop responding at all. */
export function checkLive(): { status: number; body: { alive: true } } {
  return { status: 200, body: { alive: true } };
}
