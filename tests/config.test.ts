import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/index.ts";

test("dev config tolerates missing optional vars and defaults PORT to 8080", () => {
  const cfg = loadConfig({ NODE_ENV: "development" });
  assert.equal(cfg.isProduction, false);
  assert.equal(cfg.port, 8080);
});

test("PORT is read from env, never hardcoded", () => {
  const cfg = loadConfig({ NODE_ENV: "development", PORT: "3000" });
  assert.equal(cfg.port, 3000);
});

test("production FAILS CLOSED when required vars are missing", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://app.v12.com" }),
    /Missing required production variables/,
  );
});

test("production rejects wildcard CORS", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@db/x",
        REDIS_URL: "redis://r:6379",
        STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_WEBHOOK_SECRET: "whsec_x",
        STORAGE_BUCKET: "b",
        CORS_ORIGINS: "*",
      }),
    /Wildcard CORS/,
  );
});

test("fully configured production boots", () => {
  const cfg = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db/x",
    REDIS_URL: "redis://r:6379",
    STRIPE_SECRET_KEY: "sk_live_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STORAGE_BUCKET: "b",
    CORS_ORIGINS: "https://app.v12.com, https://studio.v12.com",
  });
  assert.equal(cfg.isProduction, true);
  assert.deepEqual(cfg.corsOrigins, ["https://app.v12.com", "https://studio.v12.com"]);
});
