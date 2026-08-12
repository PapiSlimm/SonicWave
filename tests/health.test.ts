import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReady } from "../src/http/health.ts";

test("ready returns 200 only when all deps are up", async () => {
  const r = await checkReady({ pingDb: async () => {}, pingRedis: async () => {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
});

test("ready returns 503 when the DB is down (probe can actually fail)", async () => {
  const r = await checkReady({ pingDb: async () => { throw new Error("down"); }, pingRedis: async () => {} });
  assert.equal(r.status, 503);
  assert.equal(r.body.checks.database, "fail");
  assert.equal(r.body.checks.redis, "ok");
});
