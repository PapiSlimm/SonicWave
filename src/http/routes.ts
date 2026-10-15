/**
 * routes.ts — SonicWave HTTP API routes.
 *
 * Exported via the named function `createRoutes(deps)` so server.ts
 * can dependency-inject db, storage, queues, stripe, etc.
 * (SW-003: was `export default r`, which caused a TypeScript import error.)
 *
 * All security, correctness, and build issues fixed per audit:
 *   SW-001  state_json → state column name
 *   SW-002  createRoutes named export (was `export default r`)
 *   SW-003  DI for db, storage, audioQueue, aiQueue, stripe, verifyToken
 *   SW-004  applyStatePatch call signature fixed (added expectedVersion param)
 *   SW-005  getProjectOwner replaces non-existent getOwnedProject
 *   SW-006  is_public guard on /api/public/projects/:id
 *   SW-007  remix source-visibility check
 *   SW-008  ownership check on /api/jobs/render
 *   SW-009  ownership check on /api/jobs/:jobId
 *   SW-010  VERSION_CONFLICT error code matched correctly
 *   SW-011  state+event updates wrapped in a transaction
 *   SW-012  Stripe webhook idempotency uses makeWebhookStore (ON CONFLICT)
 *   SW-013  entitlements table used for subscription lookup (not `users`)
 */
import express, { Router, Request, Response } from "express";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import type Stripe from "stripe";
import type { Db } from "../db/pg.js";
import {
  applyStatePatch,
  makeProjectAuthz,
  makeWebhookStore,
  withTransaction,
} from "../db/pg.js";
import type { S3Storage } from "../storage/s3.js";
import type { Queue } from "bullmq";
import type { VerifyTokenFn } from "../middleware/auth.js";
import { makeAuthMiddleware } from "../middleware/auth.js";
import { logger, type LogObj } from "../lib/logger.js";

// ─── Dependency-injection contract ───────────────────────────────────────────

export interface RouteDeps {
  db:           Db;
  storage:      S3Storage;
  audioQueue:   Queue;
  aiQueue?:     Queue;
  stripe?:      Stripe;
  verifyToken:  VerifyTokenFn;
  config:       { migrateSecret?: string };
  logger?:      { info: (o: LogObj, m?: string) => void; warn: (o: LogObj, m?: string) => void; error: (o: LogObj, m?: string) => void };
}

// ─── Upload Policy ────────────────────────────────────────────────────────────

interface UploadPolicy { maxBytes: number; label: string; }

const UPLOAD_POLICIES: Record<string, UploadPolicy | undefined> = {
  "video/mp4":            { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/quicktime":      { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/webm":           { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/mpeg":           { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/ogg":            { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/x-msvideo":      { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/x-matroska":     { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "video/x-flv":          { maxBytes: 2 * 1024 ** 3,   label: "video" },
  "audio/wav":            { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/x-wav":          { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/mpeg":           { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/mp3":            { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/ogg":            { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/flac":           { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/aiff":           { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/x-aiff":         { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/aac":            { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/mp4":            { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/webm":           { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "audio/opus":           { maxBytes: 500 * 1024 ** 2, label: "audio" },
  "image/jpeg":           { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/png":            { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/gif":            { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/webp":           { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/svg+xml":        { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/tiff":           { maxBytes: 100 * 1024 ** 2, label: "image" },
  "image/bmp":            { maxBytes: 100 * 1024 ** 2, label: "image" },
  "application/pdf":      { maxBytes: 100 * 1024 ** 2, label: "document" },
  "application/msword":   { maxBytes: 100 * 1024 ** 2, label: "document" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                          { maxBytes: 100 * 1024 ** 2, label: "document" },
  "application/zip":      { maxBytes: 500 * 1024 ** 2, label: "archive" },
  "application/x-zip-compressed": { maxBytes: 500 * 1024 ** 2, label: "archive" },
  "application/x-tar":    { maxBytes: 500 * 1024 ** 2, label: "archive" },
  "application/octet-stream": { maxBytes: 500 * 1024 ** 2, label: "binary" },
};

function getUploadPolicy(contentType: string): UploadPolicy | null {
  const mime = (contentType.split(";")[0] ?? contentType).trim().toLowerCase();
  const policy: UploadPolicy | undefined = UPLOAD_POLICIES[mime];
  if (policy !== undefined) return policy;
  if (mime.startsWith("audio/")) return { maxBytes: 500 * 1024 ** 2, label: "audio" };
  if (mime.startsWith("video/")) return { maxBytes: 2 * 1024 ** 3,   label: "video" };
  if (mime.startsWith("image/")) return { maxBytes: 100 * 1024 ** 2, label: "image" };
  return null;
}

// ─── Route factory ────────────────────────────────────────────────────────────

export function createRoutes(deps: RouteDeps): Router {
  const { db, storage, audioQueue, aiQueue, stripe, verifyToken, config } = deps;

  // Per-route auth middleware wired to the injected verifyToken function.
  const authenticate = makeAuthMiddleware(verifyToken);

  const r: Router = Router();

  // ── Health ──────────────────────────────────────────────────────────────────

  r.get("/health/live",  (_req, res) => res.json({ alive: true }));
  r.get("/health/ready", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ready: true, checks: { database: "ok" } });
    } catch {
      res.status(503).json({ ready: false, checks: { database: "error" } });
    }
  });

  // ── Projects ────────────────────────────────────────────────────────────────

  r.get("/api/projects", authenticate, async (req: Request, res: Response) => {
    try {
      const uid = req.user!.uid;
      const { rows } = await db.query(
        "SELECT id, name, bpm, is_public, created_at, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC",
        [uid],
      );
      res.json(rows);
    } catch (err: any) {
      logger.error({ err }, "GET /api/projects failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  r.post("/api/projects", authenticate, async (req: Request, res: Response) => {
    try {
      const uid  = req.user!.uid;
      const name = (req.body?.name as string | undefined) ?? "Untitled Project";
      const id   = uuidv4();
      await db.query(
        "INSERT INTO projects (id, name, user_id) VALUES ($1, $2, $3)",
        [id, name, uid],
      );
      await db.query(
        "INSERT INTO project_states (project_id, state, ydoc, version) VALUES ($1, $2::jsonb, $3, 0)",
        [id, JSON.stringify({}), Buffer.alloc(0)],
      );
      res.status(201).json({ id, name, user_id: uid });
    } catch (err: any) {
      logger.error({ err }, "POST /api/projects failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  r.get("/api/projects/:id", authenticate, async (req: Request, res: Response) => {
    try {
      const uid   = req.user!.uid;
      const authz = makeProjectAuthz(db);
      const owner = await authz.getProjectOwner((req.params["id"] as string));
      if (!owner) return res.status(404).json({ error: "not_found" });
      const isOwner = owner === uid;
      const isCollab = !isOwner && await authz.isCollaborator((req.params["id"] as string), uid);
      if (!isOwner && !isCollab) return res.status(403).json({ error: "forbidden" });
      const { rows: [state] } = await db.query(
        "SELECT version, state FROM project_states WHERE project_id = $1",
        [(req.params["id"] as string)],
      );
      const { rows: [project] } = await db.query(
        "SELECT id, name, bpm, is_public, created_at, updated_at FROM projects WHERE id = $1",
        [(req.params["id"] as string)],
      );
      res.json({ ...project, state: state?.state ?? null, version: state?.version ?? 0 });
    } catch (err: any) {
      logger.error({ err }, "GET /api/projects/:id failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  r.patch(
    "/api/projects/:id",
    express.json({ limit: "50mb" }),
    authenticate,
    async (req: Request, res: Response) => {
      const projectId = (req.params["id"] as string);
      const uid       = req.user!.uid;
      try {
        const authz = makeProjectAuthz(db);
        const owner = await authz.getProjectOwner(projectId);
        if (!owner) return res.status(404).json({ error: "not_found" });
        const isOwner  = owner === uid;
        const isCollab = !isOwner && await authz.isCollaborator(projectId, uid);
        if (!isOwner && !isCollab) return res.status(403).json({ error: "forbidden" });

        const { op }             = req.body ?? {};
        const expectedVersion    = (req.body?.expectedVersion as number | undefined) ?? 0;

        // SW-011: wrap state update + event insert in a single transaction.
        const result = await withTransaction(db, async (txDb) => {
          const r = await applyStatePatch(
            txDb,
            projectId,
            expectedVersion,
            op?.nextState ?? req.body,
          );
          await txDb.query(
            `INSERT INTO project_events (project_id, user_id, event_type, payload, version)
             VALUES ($1, $2, $3, $4, $5)`,
            [projectId, uid, op?.type ?? "GENERAL_UPDATE", JSON.stringify(op?.payload ?? {}), r.version],
          );
          return r;
        });
        res.json({ success: true, version: result.version });
      } catch (err: any) {
        // SW-010: pg.ts throws { code: "VERSION_CONFLICT" }
        if (err.code === "VERSION_CONFLICT") {
          return res.status(409).json({ error: "version_conflict" });
        }
        logger.error({ err }, "PATCH /api/projects/:id failed");
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  r.delete("/api/projects/:id", authenticate, async (req: Request, res: Response) => {
    try {
      const uid   = req.user!.uid;
      const authz = makeProjectAuthz(db);
      const owner = await authz.getProjectOwner((req.params["id"] as string));
      if (!owner) return res.status(404).json({ error: "not_found" });
      if (owner !== uid) return res.status(403).json({ error: "forbidden" });
      await db.query("DELETE FROM projects WHERE id = $1", [(req.params["id"] as string)]);
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, "DELETE /api/projects/:id failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Public / Remix ──────────────────────────────────────────────────────────

  // SW-006: guard on is_public — anonymous callers may only read public projects.
  r.get("/api/public/projects/:id", async (req: Request, res: Response) => {
    try {
      const { rows: [project] } = await db.query(
        "SELECT id, name, bpm, is_public FROM projects WHERE id = $1",
        [(req.params["id"] as string)],
      );
      if (!project) return res.status(404).json({ error: "not_found" });
      if (!project.is_public) return res.status(403).json({ error: "forbidden" });
      const { rows: [state] } = await db.query(
        "SELECT state FROM project_states WHERE project_id = $1",
        [(req.params["id"] as string)],
      );
      res.json({ ...project, state: state?.state ?? null });
    } catch (err: any) {
      logger.error({ err }, "GET /api/public/projects/:id failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // SW-007: remix only allowed if source is public OR requester is owner/collaborator.
  r.post("/api/projects/:id/remix", authenticate, async (req: Request, res: Response) => {
    try {
      const uid  = req.user!.uid;
      const { rows: [src] } = await db.query(
        "SELECT id, name, bpm, is_public, user_id FROM projects WHERE id = $1",
        [(req.params["id"] as string)],
      );
      if (!src) return res.status(404).json({ error: "not_found" });

      // Visibility check: source must be public or requester must be owner/collab.
      const authz    = makeProjectAuthz(db);
      const isOwner  = src.user_id === uid;
      const isCollab = !isOwner && await authz.isCollaborator((req.params["id"] as string), uid);
      if (!src.is_public && !isOwner && !isCollab) {
        return res.status(403).json({ error: "forbidden" });
      }

      const { rows: [srcState] } = await db.query(
        "SELECT state, ydoc FROM project_states WHERE project_id = $1",
        [(req.params["id"] as string)],
      );
      const newId = uuidv4();
      await db.query(
        "INSERT INTO projects (id, name, user_id, bpm) VALUES ($1, $2, $3, $4)",
        [newId, `Remix of ${src.name}`, uid, src.bpm],
      );
      await db.query(
        "INSERT INTO project_states (project_id, state, ydoc, version) VALUES ($1, $2::jsonb, $3, 0)",
        [newId, JSON.stringify(srcState?.state ?? {}), srcState?.ydoc ?? Buffer.alloc(0)],
      );
      res.status(201).json({ id: newId });
    } catch (err: any) {
      logger.error({ err }, "POST /api/projects/:id/remix failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Media Upload ─────────────────────────────────────────────────────────────

  r.post("/api/upload", authenticate, (req: Request, res: Response) => {
    const contentType = req.headers["content-type"] ?? "";

    if (contentType.includes("multipart/form-data")) {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 2 * 1024 ** 3 } });
      let responded = false;

      bb.on("file", (fieldname, stream, info) => {
        const { filename, mimeType } = info;
        const policy = getUploadPolicy(mimeType);
        if (!policy) {
          stream.resume();
          if (!responded) {
            responded = true;
            res.status(415).json({ error: "unsupported_media_type", mimeType });
          }
          return;
        }
        const objectName = `uploads/${uuidv4()}-${filename}`;
        const { stream: s3Stream, done } = storage.createUploadStream(objectName, mimeType);

        let bytes = 0;
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > policy.maxBytes) {
            stream.destroy();
            s3Stream.destroy();
            if (!responded) {
              responded = true;
              res.status(413).json({ error: "file_too_large", maxBytes: policy.maxBytes });
            }
          }
        });
        stream.pipe(s3Stream);

        done
          .then((fileUrl) => {
            if (!responded) {
              responded = true;
              res.json({ fileUrl, fileName: filename, mimeType, label: policy.label, objectName });
            }
          })
          .catch((err: Error) => {
            logger.error({ err }, "S3 multipart upload error");
            if (!responded) { responded = true; res.status(500).json({ error: "upload_failed" }); }
          });
      });

      bb.on("finish", () => {
        if (!responded) { responded = true; res.status(400).json({ error: "no_file_received" }); }
      });
      req.pipe(bb);
      return;
    }

    // Raw binary upload
    const policy = getUploadPolicy(contentType);
    if (!policy) return res.status(415).json({ error: "unsupported_media_type", contentType });
    const filename   = (req.headers["x-file-name"] as string) ?? "upload";
    const objectName = `uploads/${uuidv4()}-${filename}`;
    const { stream: s3Stream, done } = storage.createUploadStream(objectName, contentType);

    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > policy.maxBytes) {
        req.destroy();
        s3Stream.destroy();
        if (!res.headersSent) res.status(413).json({ error: "file_too_large", maxBytes: policy.maxBytes });
      }
    });
    req.pipe(s3Stream);

    done
      .then((fileUrl) => {
        if (!res.headersSent)
          res.json({ fileUrl, fileName: filename, mimeType: contentType, label: policy.label, objectName });
      })
      .catch((err: Error) => {
        logger.error({ err }, "S3 raw upload error");
        if (!res.headersSent) res.status(500).json({ error: "upload_failed" });
      });
  });

  // ── Job Queues ──────────────────────────────────────────────────────────────

  // SW-008: verify projectId ownership before queuing a render job.
  r.post("/api/jobs/render", authenticate, async (req: Request, res: Response) => {
    try {
      const uid = req.user!.uid;
      const { projectId, format = "wav", quality = "high" } = req.body ?? {};
      if (!projectId) return res.status(400).json({ error: "projectId required" });

      const authz = makeProjectAuthz(db);
      const owner = await authz.getProjectOwner(projectId);
      if (!owner) return res.status(404).json({ error: "not_found" });
      const isCollab = owner !== uid && await authz.isCollaborator(projectId, uid);
      if (owner !== uid && !isCollab) return res.status(403).json({ error: "forbidden" });

      const job = await audioQueue.add("render", { projectId, uid, format, quality });
      res.status(202).json({ jobId: job.id });
    } catch (err: any) {
      logger.error({ err }, "POST /api/jobs/render failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // SW-009: only the job owner may poll job status.
  r.get("/api/jobs/:jobId", authenticate, async (req: Request, res: Response) => {
    try {
      const uid = req.user!.uid;
      const job = await audioQueue.getJob(req.params["jobId"] as string);
      if (!job) return res.status(404).json({ error: "not_found" });
      if (job.data?.uid !== uid) return res.status(403).json({ error: "forbidden" });
      res.json({
        jobId:    job.id,
        state:    await job.getState(),
        progress: job.progress,
        result:   job.returnvalue,
      });
    } catch (err: any) {
      logger.error({ err }, "GET /api/jobs/:jobId failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  r.post("/api/jobs/ai", authenticate, async (req: Request, res: Response) => {
    if (!aiQueue) return res.status(503).json({ error: "ai_queue_not_configured" });
    try {
      const uid = req.user!.uid;
      const job = await aiQueue.add("ai-generate", { uid, ...req.body });
      res.status(202).json({ jobId: job.id });
    } catch (err: any) {
      logger.error({ err }, "POST /api/jobs/ai failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // ── Stripe Billing ────────────────────────────────────────────────────────

  r.post("/api/billing/create-checkout", authenticate, async (req: Request, res: Response) => {
    try {
      if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
      const { priceId } = req.body ?? {};
      if (!priceId) return res.status(400).json({ error: "priceId required" });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${(req.headers["origin"] as string | undefined) ?? ""}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${(req.headers["origin"] as string | undefined) ?? ""}/billing/cancel`,
        client_reference_id: req.user!.uid,
      });
      res.json({ url: session.url });
    } catch (err: any) {
      logger.error({ err }, "POST /api/billing/create-checkout failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // SW-013: use the entitlements table (not the non-existent `users` table).
  r.get("/api/billing/subscription", authenticate, async (req: Request, res: Response) => {
    try {
      const uid = req.user!.uid;
      const { rows: [ent] } = await db.query(
        "SELECT plan, stripe_customer_id, subscription_id, current_period_end FROM entitlements WHERE user_id = $1",
        [uid],
      );
      if (!ent?.stripe_customer_id) return res.json({ plan: ent?.plan ?? "FREE" });
      if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
      const subs = await stripe.subscriptions.list({
        customer: ent.stripe_customer_id, status: "active", limit: 1,
      });
      res.json(subs.data[0] ?? { plan: "FREE" });
    } catch (err: any) {
      logger.error({ err }, "GET /api/billing/subscription failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  // SW-012: idempotency via makeWebhookStore (uses ON CONFLICT DO NOTHING).
  r.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req: Request, res: Response) => {
      if (!stripe) return res.status(503).json({ error: "stripe_not_configured" });
      const sig    = req.headers["stripe-signature"] as string;
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
      let event: any;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, secret);
      } catch (err: any) {
        logger.warn({ err }, "Stripe webhook signature mismatch");
        return res.status(400).json({ error: "invalid_signature" });
      }

      const webhookStore = makeWebhookStore(db);
      const already = await webhookStore.alreadyProcessed(event.id);
      if (already) return res.json({ received: true, skipped: true });

      try {
        switch (event.type) {
          case "customer.subscription.created":
          case "customer.subscription.updated": {
            const sub = event.data.object;
            await db.query(
              `INSERT INTO entitlements (user_id, plan, stripe_customer_id, subscription_id, current_period_end)
               VALUES ((SELECT user_id FROM entitlements WHERE stripe_customer_id = $1 LIMIT 1), $2, $1, $3, $4)
               ON CONFLICT (user_id) DO UPDATE
                 SET plan = EXCLUDED.plan, subscription_id = EXCLUDED.subscription_id,
                     current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
              [
                sub.customer,
                sub.items?.data?.[0]?.price?.nickname ?? "paid",
                sub.id,
                sub.current_period_end ?? null,
              ],
            );
            break;
          }
          case "customer.subscription.deleted": {
            const sub = event.data.object;
            await db.query(
              "UPDATE entitlements SET plan = 'FREE', subscription_id = NULL WHERE stripe_customer_id = $1",
              [sub.customer],
            );
            break;
          }
        }
        await webhookStore.markProcessed(event.id, event.type);
        res.json({ received: true });
      } catch (err: any) {
        logger.error({ err }, "Webhook handler error");
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  // ── Admin: Run Migrations ─────────────────────────────────────────────────

  r.post("/api/admin/migrate", async (req: Request, res: Response) => {
    const secret = config.migrateSecret;
    if (!secret) return res.status(404).json({ error: "not_found" });
    if (req.headers["x-migrate-secret"] !== secret)
      return res.status(403).json({ error: "forbidden" });
    const { migration } = req.body ?? {};
    if (!migration) return res.status(400).json({ error: "migration name required" });
    const migrationsDir = join(process.cwd(), "migrations");
    let matchFile: string | undefined;
    try {
      matchFile = readdirSync(migrationsDir).find(
        (f) => f.startsWith(`${migration}_`) && f.endsWith(".sql"),
      );
    } catch {
      return res.status(500).json({ error: "migrations directory not readable" });
    }
    if (!matchFile) return res.status(404).json({ error: `migration not found: ${migration}` });
    try {
      const sql = readFileSync(join(migrationsDir, matchFile), "utf8");
      await db.query(sql);
      logger.info({ migration, file: matchFile }, "Migration applied");
      res.json({ success: true, file: matchFile });
    } catch (err: any) {
      logger.error({ err, migration }, "Migration failed");
      res.status(500).json({ error: "internal_error" });
    }
  });

  return r;
}
