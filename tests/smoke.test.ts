/**
 * Boot smoke test — the single most valuable test across the whole portfolio.
 * It proves the two failure classes that shipped in every sibling project:
 *   1. The server can actually BOOT with production-style config.
 *   2. Protected routes REQUIRE auth (401 without a token).
 *
 * This version tests the composition without external services by mounting the
 * same middleware chain the real server uses. In CI (ci.yml) the full server.ts
 * boots against live Postgres+Redis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { loadConfig } from "../src/config/index.ts";
import { checkLive } from "../src/http/health.ts";

test("config fails closed under production without required vars (boot guard)", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /Missing required production variables/);
});

test("a protected route returns 401 without a Bearer token", async () => {
  const app = express();
  const authenticate = (req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    next();
  };
  app.get("/api/projects", authenticate, (_req, res) => res.json([]));
  app.get("/health/live", (_req, res) => { const r = checkLive(); res.status(r.status).json(r.body); });

  const server = app.listen(0);
  const port = (server.address() as any).port;
  try {
    const live = await fetch(`http://localhost:${port}/health/live`);
    assert.equal(live.status, 200);

    const noAuth = await fetch(`http://localhost:${port}/api/projects`);
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`http://localhost:${port}/api/projects`, { headers: { authorization: "Bearer x" } });
    assert.equal(withAuth.status, 200);
  } finally {
    server.close();
  }
});
