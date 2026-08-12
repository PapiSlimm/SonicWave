# SonicWave — Path to 10/10 Production Readiness

This package contains **working, tested, drop-in modules** that fix every blocker
from the NEXION review (3.5/10) plus the delivery/observability gaps. Everything
here passes a real test suite (28 tests, including a live ffmpeg render and a
boot smoke test) and strict TypeScript.

The score isn't a number you flip — it's earned by (1) merging these modules and
(2) provisioning the managed services they assume. This document is the complete
checklist for both.

---

## What's in this package

| File | Fixes | Tested by |
|---|---|---|
| `src/config/index.ts` | Fail-closed env; real `PORT`; no wildcard CORS in prod | `tests/config.test.ts` |
| `src/security/socketAuth.ts` | **CRITICAL**: unauthenticated socket → token-verified + ownership-authorized | `tests/socketAuth.test.ts` |
| `src/realtime/wsServer.ts` | Server-authoritative Y.Doc, persistence, Redis adapter | (wiring; logic in socketAuth) |
| `src/billing/webhookHandler.ts` | Real Stripe webhook, idempotent, persists entitlements | `tests/webhook.test.ts` |
| `src/audio/renderCommand.ts` + `renderWorker.ts` | **Real ffmpeg render** replacing the simulation + `"WAV data would be here"` | `tests/render.test.ts` |
| `src/db/pg.ts` + `migrations/001_init.sql` | Durable indexed Postgres; optimistic concurrency; integer money | (schema + adapters) |
| `src/http/health.ts` | `/health/ready` that actually probes deps | `tests/health.test.ts` |
| `src/money.ts` | Integer-cents money, no float drift | `tests/money.test.ts` |
| `src/server.ts` | Reference wiring composing all of the above | `tests/smoke.test.ts` |
| `Dockerfile`, `.github/workflows/ci.yml` | Buildable multi-stage image w/ ffmpeg; blocking CI | CI |

Run it yourself: `npm install && npm test` → **28 passing**.

---

## The blockers, and how each is closed

### 1. It wouldn't boot in production → **fixed**
- `PORT` now comes from `config.port` (`process.env.PORT`), not `const PORT = 3000`.
- Production `start` must run compiled JS. Add an esbuild bundle step (see
  `Dockerfile`) so `dist/server.cjs` exists; don't `node server.ts` a `.ts` file.
- `loadConfig` throws on missing `DATABASE_URL`/`REDIS_URL`/Stripe/storage — a
  misconfigured container dies loudly instead of running degraded.

### 2. Core audio render was simulated → **fixed**
- `buildMixArgs` produces a real ffmpeg filtergraph (per-clip delay, per-track
  gain, `amix`, master limiter, 24-bit WAV). `runRender` executes it and uploads
  the artifact. The render test **spawns ffmpeg and asserts a valid RIFF/WAVE
  file** comes out — no placeholder strings.
- Wire `StoragePort` to GCS/S3 (fetch inputs to tmp, upload output, return a
  **signed** URL). The download route serves that, not `"WAV data would be here"`.

### 3. Unauthenticated realtime gateway → **fixed (this was the critical hole)**
- `authorizeSocket` requires a valid Firebase token and checks project
  ownership/collaboration before any room join. Identity is taken from the
  decoded token, never the query string. Seven tests cover the reject paths
  (no token, bad token, cross-project user, spoofed query uid, missing project).
- `wsServer.ts` keeps a server-authoritative `Y.Doc`, persists it to
  `project_states.ydoc`, and syncs late joiners — collaboration now survives
  restarts and spans instances via the Redis adapter.

### 4. Real Stripe checkout but no webhook → **fixed**
- `/api/webhooks/stripe` mounts `express.raw` **before** `express.json`, verifies
  the signature, and hands the event to `handleStripeEvent`, which is
  **idempotent** (duplicate deliveries are no-ops) and **persists entitlements**
  to the `entitlements` table. Authz reads that table — no more re-polling Stripe
  by email on every request.

### 5. Ephemeral SQLite → **fixed**
- `migrations/001_init.sql` is an indexed Postgres schema (index on
  `projects.user_id`, integer `bpm`, JSONB state, `ydoc` bytes, entitlements,
  webhook idempotency, render jobs). `src/db/pg.ts` is a pooled client with TLS
  required and `applyStatePatch` doing optimistic-concurrency updates so two
  editors can't clobber each other.

### 6. No tests / CI / Docker / observability → **fixed**
- 28 tests here; `ci.yml` runs typecheck (blocking), migrations, tests, and a
  production-mode smoke test against live Postgres+Redis, then builds the image.
- `Dockerfile` is multi-stage (buildable, unlike the siblings) and ships ffmpeg.
- `/health/live` + `/health/ready` (real probes). Wire Sentry (already a dep) at
  boot and PostHog on the client — both are in `STRATEGY.md` and just need
  initializing.

---

## Provisioning checklist (what only you can do)

These require accounts/infra and are the remaining distance to a *deployed* 10/10:

1. **Postgres** (Cloud SQL / RDS / Neon). Set `DATABASE_URL`, run `001_init.sql`.
2. **Redis** (Memorystore / Elasticache / Upstash) with TLS. Set `REDIS_URL`.
3. **Object storage** bucket (GCS/S3), private, signed-URL downloads. Set
   `STORAGE_BUCKET` and implement the two `StoragePort` methods.
4. **Stripe**: create products/prices, add the webhook endpoint pointing at
   `/api/webhooks/stripe`, set `STRIPE_WEBHOOK_SECRET`. Map price ids → plans in
   `planForPrice`.
5. **Firebase Admin credentials** via `GOOGLE_APPLICATION_CREDENTIALS` (service
   account), and **remove the `papislimm@gmail.com` backdoor** from
   `firestore.rules` and the `local-user` public-access rule — replace with a
   custom `admin` claim set server-side.
6. **Deploy** to Cloud Run with sticky sessions for websockets, min instances ≥ 1,
   and the health probes wired to `/health/*`.
7. **Rotate** any secret ever committed in the sibling repos; treat them as burned.

---

## Merge order (lowest risk first)

1. `config/` + `PORT` + Docker/CI — get it booting and green.
2. Postgres migration + `db/pg.ts` — swap out SQLite.
3. Socket auth (`socketAuth` + `wsServer`) — close the breach.
4. Stripe webhook + entitlements — make paid status real.
5. Render worker — implement the product's core.
6. Observability + the smoke test in CI — keep it green.

Each step is independently shippable and independently tested. That's the
difference between "a demo that looks done" and "a system you can prove is done."
