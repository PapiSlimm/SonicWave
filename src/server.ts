/**
 * SonicWave — production server bootstrap.
 *
 * All REST routes are now wired in via createRoutes() (src/http/routes.ts).
 * The architecture matches the rest of the codebase: dependencies injected,
 * fail-closed config, no hardcoded secrets.
 *
 * Routes live:
 *   POST   /api/webhooks/stripe           — Stripe webhook (raw body, sig verified)
 *   POST/GET /api/ecosystem/feed/*        — V12 ecosystem event intake
 *   GET    /api/projects                  — list caller's projects
 *   POST   /api/projects                  — create project
 *   GET    /api/projects/:id              — fetch project (owner/collaborator)
 *   PATCH  /api/projects/:id              — update state (optimistic concurrency)
 *   DELETE /api/projects/:id              — delete (owner only)
 *   GET    /api/public/projects/:id       — public project (no auth)
 *   POST   /api/projects/:id/remix        — fork a public project
 *   POST   /api/projects/:id/collaborators— add collaborator (owner only)
 *   POST   /api/render/start              — enqueue cloud render (CREATOR+)
 *   GET    /api/render/status/:jobId      — poll render progress
 *   GET    /api/billing/plan              — current plan
 *   POST   /api/billing/create-checkout   — Stripe checkout session
 *   GET    /api/billing/portal            — Stripe customer portal
 *   POST   /api/upload                    — upload audio to GCS (100 MB max)
 *   GET    /api/ecosystem/ping            — V12 ecosystem health check
 *   POST   /api/auth/exchange-v12-token   — cross-app token exchange
 *   POST   /api/ai/generate-track         — MiniMax Music 3.0 AI generation
 *   GET    /api/ai/audio/:id              — stream generated audio
 *   GET    /health/live                   — liveness probe
 *   GET    /health/ready                  — readiness probe (DB + Redis)
 */
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import IORedis from "ioredis";
import admin from "firebase-admin";
import Stripe from "stripe";
import { Queue } from "bullmq";
import { logger } from "./lib/logger.ts";
import { loadConfig } from "./config/index.ts";
import { createDb, applyStatePatch, makeWebhookStore, makeProjectAuthz } from "./db/pg.ts";
import { runMigrations } from "./db/migrate.ts";
import { checkReady, checkLive } from "./http/health.ts";
import { createRoutes } from "./http/routes.ts";
import { initCollaborationGateway } from "./realtime/wsServer.ts";
import { handleStripeEvent } from "./billing/webhookHandler.ts";
import { createRenderWorker, type StoragePort } from "./audio/renderWorker.ts";
import { createFeedIntake } from "./ecosystem/v12-feed-intake.ts";
import { createMusicGen } from "./ai/musicGen.ts";

const config = loadConfig(process.env); // THROWS if misconfigured — intended.

async function main() {
  const db       = await createDb(config.databaseUrl!);
  // Schema self-applies at boot - migrations/*.sql, once each, loudly on failure.
  await runMigrations(db);
  const redis    = new IORedis(config.redisUrl!, { maxRetriesPerRequest: null });
  const subRedis = redis.duplicate();

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: config.firebaseProjectId });
  }
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : undefined;

  const verifyToken = async (token: string) => {
    const d = await admin.auth().verifyIdToken(token);
    return { uid: d.uid, email: d.email };
  };

  const app        = express();
  const httpServer = createServer(app);

  // ── CORS ────────────────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    const origin = req.headers.origin ?? "";
    if (config.corsOrigins.length === 0 || config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin",  origin || "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-V12-App-Id");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ── Stripe webhook — RAW BODY before express.json ──────────────────────────
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe || !config.stripeWebhookSecret) return res.status(503).json({ error: "not_configured" });
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"] as string,
        config.stripeWebhookSecret,
      );
    } catch (err: any) {
      return res.status(400).send(`Webhook signature failed: ${err.message}`);
    }
    try {
      const store = makeWebhookStore(db);
      await handleStripeEvent(event as any, {
        ...store,
        planForPrice: (priceId) =>
          priceId.includes("label")      ? "ENTERPRISE" :
          priceId.includes("pro")        ? "PRO"        :
          priceId.includes("creator")    ? "PRO"        : "FREE",
        logger,
      });
      res.json({ received: true });
    } catch (err: any) {
      logger.error({ err: err.message }, "Webhook handler error");
      res.status(500).json({ error: "handler_error" });
    }
  });

  // ── V12 ecosystem feed intake — raw-body HMAC, before express.json ─────────
  app.use("/api/ecosystem/feed", createFeedIntake({ serviceId: "sonicwave" }));

  app.use(express.json({ limit: "2mb" }));

  // ── Root route — identifies the API so Cloud Run health checks + browsers ──
  // get a proper response instead of "Cannot GET /"
  app.get("/", (_req, res) => res.json({
    service:  "SonicWave API",
    version:  process.env.npm_package_version ?? "1.0.0",
    status:   "ok",
    docs:     "/health/ready",
  }));

  // ── Health probes ───────────────────────────────────────────────────────────
  app.get("/health/live",  (_req, res) => { const r = checkLive(); res.status(r.status).json(r.body); });
  app.get("/health/ready", async (_req, res) => {
    const r = await checkReady({ pingDb: () => db.ping(), pingRedis: async () => { await redis.ping(); } });
    res.status(r.status).json(r.body);
  });

  // ── All REST routes ─────────────────────────────────────────────────────────
  const audioQueue = new Queue("audio-processing", { connection: redis });

  const storage: StoragePort = {
    fetchToLocal: async (src) => src,           // TODO: download from GCS to tmp
    upload: async (_local, key) =>              // TODO: real GCS upload + signed URL
      `https://storage.googleapis.com/${config.storageBucket}/${key}`,
  };

  const authz = makeProjectAuthz(db);

  app.use(createRoutes({
    db,
    storage,
    config,
    audioQueue,
    verifyToken,
    applyPatch: applyStatePatch,
    stripe,
    logger,
  }));

  // ── AI music generation ─────────────────────────────────────────────────────
  app.use(createMusicGen({
    db,
    verifyToken,
    getProjectOwner: authz.getProjectOwner,
    isCollaborator:  authz.isCollaborator,
    logger,
  }));

  // ── Socket.IO: authenticated, authorized, Redis-adapted, multi-instance ─────
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, methods: ["GET", "POST"], credentials: true },
  });
  io.adapter(createAdapter(redis, subRedis));

  initCollaborationGateway(io, {
    verifyToken,
    getProjectOwner:  authz.getProjectOwner,
    isCollaborator:   authz.isCollaborator,
    logger,
    loadDocUpdate: async (pid) => {
      const { rows } = await db.query<{ ydoc: Buffer | null }>(
        "SELECT ydoc FROM project_states WHERE project_id = $1", [pid],
      );
      return rows[0]?.ydoc ? new Uint8Array(rows[0].ydoc) : null;
    },
    saveDocUpdate: async (pid, update) => {
      await db.query(
        "UPDATE project_states SET ydoc = $1, updated_at = now() WHERE project_id = $2",
        [Buffer.from(update), pid],
      );
    },
  });

  // ── Audio render worker ─────────────────────────────────────────────────────
  createRenderWorker(
    (await import("bullmq")).Worker,
    redis,
    {
      storage,
      loadProjectMix: async (pid) => {
        const { rows } = await db.query<{ state: any }>(
          "SELECT state FROM project_states WHERE project_id = $1", [pid],
        );
        return rows[0]?.state ?? { tracks: [] };
      },
    },
  );

  httpServer.listen(config.port, "0.0.0.0", () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "SonicWave server listening");
    logger.info({
      routes:   "all wired",
      stripe:   !!stripe,
      minimax:  !!(process.env.MINIMAX_API_KEY && process.env.MINIMAX_API_KEY !== "PENDING"),
      corsOrigins: config.corsOrigins,
    }, "Service ready");
  });
}

main().catch((err) => {
  logger.error({ err: err.message }, "Fatal boot error");
  process.exit(1);
});
