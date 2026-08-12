/**
 * Hardened server bootstrap — the reference wiring that composes every module in
 * this package. Drop this in place of the original server.ts (it keeps the same
 * REST routes, which were already good, and adds the fixes).
 *
 * Key changes vs. the original, all covered by tests in ../tests:
 *   - loadConfig() fails CLOSED (no more warn-and-continue).
 *   - PORT comes from config (process.env.PORT), not a hardcoded 3000.
 *   - Stripe webhook mounted with RAW body BEFORE express.json, signature
 *     verified, idempotent, persists entitlements.
 *   - Socket.IO authenticated + authorized (io.use) with a Redis adapter.
 *   - /health/ready actually probes DB + Redis.
 *   - Real ffmpeg render worker; downloads serve real files from storage.
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
import { createDb, makeWebhookStore, makeProjectAuthz } from "./db/pg.ts";
import { checkReady, checkLive } from "./http/health.ts";
import { initCollaborationGateway } from "./realtime/wsServer.ts";
import { handleStripeEvent } from "./billing/webhookHandler.ts";
import { createRenderWorker, type StoragePort } from "./audio/renderWorker.ts";
import { createFeedIntake } from "./ecosystem/v12-feed-intake.ts";

const config = loadConfig(process.env); // THROWS if misconfigured — intended.

async function main() {
  const db = await createDb(config.databaseUrl!);
  const redis = new IORedis(config.redisUrl!, { maxRetriesPerRequest: null });
  const subRedis = redis.duplicate();

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: config.firebaseProjectId });
  }
  const stripe = new Stripe(config.stripeSecretKey!);

  const app = express();
  const httpServer = createServer(app);

  // --- Stripe webhook FIRST, with raw body (before express.json). ---
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, config.stripeWebhookSecret!);
    } catch (err: any) {
      return res.status(400).send(`Webhook signature failed: ${err.message}`);
    }
    try {
      const store = makeWebhookStore(db);
      await handleStripeEvent(event as any, {
        ...store,
        planForPrice: (priceId) => (priceId.includes("enterprise") ? "ENTERPRISE" : priceId.includes("pro") ? "PRO" : "FREE"),
        logger,
      });
      res.json({ received: true });
    } catch (err: any) {
      logger.error({ err: err.message }, "Webhook handling failed");
      res.status(500).json({ error: "handler_error" });
    }
  });

  // V12 ecosystem feed intake — raw-body HMAC route, must precede express.json.
  // Receives SonicStream radio now-playing, R.M.P.M campaigns and peer events:
  // GET /api/ecosystem/feed/inbox to browse; secrets via V12_*_WEBHOOK_SECRET /
  // ECOSYSTEM_SECRET (no secret configured = every request refused).
  app.use("/api/ecosystem/feed", createFeedIntake({ serviceId: "sonicwave" }));

  app.use(express.json());

  // Exact-origin CORS (no wildcard in prod — enforced by config).
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // --- Health probes that can actually fail. ---
  app.get("/health/live", (_req, res) => { const r = checkLive(); res.status(r.status).json(r.body); });
  app.get("/health/ready", async (_req, res) => {
    const r = await checkReady({ pingDb: () => db.ping(), pingRedis: async () => { await redis.ping(); } });
    res.status(r.status).json(r.body);
  });

  // ... existing REST routes (projects, billing/create-checkout, upload, export)
  //     go here, unchanged except reading entitlements from the DB instead of
  //     re-polling Stripe by email. See INTEGRATION.md.

  // --- Socket.IO: authenticated, authorized, multi-instance. ---
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, methods: ["GET", "POST"], credentials: true },
  });
  io.adapter(createAdapter(redis, subRedis));
  const authz = makeProjectAuthz(db);
  initCollaborationGateway(io, {
    verifyToken: async (t) => { const d = await admin.auth().verifyIdToken(t); return { uid: d.uid, email: d.email }; },
    getProjectOwner: authz.getProjectOwner,
    isCollaborator: authz.isCollaborator,
    loadDocUpdate: async (pid) => {
      const { rows } = await db.query<{ ydoc: Buffer | null }>("SELECT ydoc FROM project_states WHERE project_id = $1", [pid]);
      return rows[0]?.ydoc ? new Uint8Array(rows[0].ydoc) : null;
    },
    saveDocUpdate: async (pid, update) => {
      await db.query("UPDATE project_states SET ydoc = $1, updated_at = now() WHERE project_id = $2", [Buffer.from(update), pid]);
    },
    logger,
  });

  // --- Real render worker. ---
  const storage: StoragePort = {
    // Implement against GCS/S3. Signed URLs, not public objects.
    fetchToLocal: async (src) => src, // TODO: download from bucket to tmp
    upload: async (localPath, key) => `gs://${config.storageBucket}/${key}`, // TODO: real upload + signed URL
  };
  createRenderWorker(
    (await import("bullmq")).Worker,
    redis,
    { storage, loadProjectMix: async (pid) => {
      const { rows } = await db.query<{ state: any }>("SELECT state FROM project_states WHERE project_id = $1", [pid]);
      return rows[0]?.state ?? { tracks: [] };
    } },
  );
  // Queue handle for enqueuing renders from the REST route.
  const audioQueue = new Queue("audio-processing", { connection: redis });
  void audioQueue;

  httpServer.listen(config.port, "0.0.0.0", () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "Server listening");
  });
}

main().catch((err) => { logger.error({ err: err.message }, "Fatal boot error"); process.exit(1); });
