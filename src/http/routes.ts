import express, { Router, Request, Response } from "express";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import Busboy from "busboy";
import { Storage } from "@google-cloud/storage";
import { pool, applyStatePatch, makeProjectAuthz } from "../db/pg.js";
import { authenticate } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import { audioQueue, aiQueue } from "../lib/queues.js";

const r: Router = Router();

// ─── Upload Policy ────────────────────────────────────────────────────────────
// BUG-01 / BUG-02 FIX:
//   Old code: audio-only MIME allowlist blocked video/mp4, images, etc. (415).
//   Fix: Broad per-type policy with per-type size caps + prefix fallback.

interface UploadPolicy { maxBytes: number; label: string; }

const UPLOAD_POLICIES: Record<string, UploadPolicy> = {
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
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (UPLOAD_POLICIES[mime]) return UPLOAD_POLICIES[mime];
  if (mime.startsWith("audio/")) return { maxBytes: 500 * 1024 ** 2, label: "audio" };
  if (mime.startsWith("video/")) return { maxBytes: 2 * 1024 ** 3,   label: "video" };
  if (mime.startsWith("image/")) return { maxBytes: 100 * 1024 ** 2, label: "image" };
  return null;
}

// ─── Health ──────────────────────────────────────────────────────────────────

r.get("/health/live",  (_req, res) => res.json({ alive: true }));
r.get("/health/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ready: true, checks: { database: "ok" } });
  } catch {
    res.status(503).json({ ready: false, checks: { database: "error" } });
  }
});

// ─── Projects ────────────────────────────────────────────────────────────────

r.get("/api/projects", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user.uid;
    const { rows } = await pool.query(
      "SELECT id, name, bpm, created_at, updated_at FROM projects WHERE user_id = $1 ORDER BY updated_at DESC",
      [uid],
    );
    res.json(rows);
  } catch (err: any) {
    logger.error({ err }, "GET /api/projects failed");
    res.status(500).json({ error: err.message });
  }
});

r.post("/api/projects", authenticate, async (req: Request, res: Response) => {
  try {
    const uid  = (req as any).user.uid;
    const name = req.body?.name ?? "Untitled Project";
    const id   = uuidv4();
    await pool.query("INSERT INTO projects (id, name, user_id) VALUES ($1, $2, $3)", [id, name, uid]);
    await pool.query(
      "INSERT INTO project_states (project_id, ydoc, version) VALUES ($1, $2, $3)",
      [id, Buffer.alloc(0), 0],
    );
    res.status(201).json({ id, name, user_id: uid });
  } catch (err: any) {
    logger.error({ err }, "POST /api/projects failed");
    res.status(500).json({ error: err.message });
  }
});

r.get("/api/projects/:id", authenticate, async (req: Request, res: Response) => {
  try {
    const authz   = makeProjectAuthz(pool);
    const project = await authz.getOwnedProject(req.params.id, (req as any).user.uid);
    if (!project) return res.status(404).json({ error: "not_found" });
    const { rows: [state] } = await pool.query(
      "SELECT version, state_json FROM project_states WHERE project_id = $1",
      [req.params.id],
    );
    res.json({ ...project, state: state?.state_json ?? null, version: state?.version ?? 0 });
  } catch (err: any) {
    logger.error({ err }, "GET /api/projects/:id failed");
    res.status(500).json({ error: err.message });
  }
});

// BUG-03 FIX:
//   Global express.json({ limit: "2mb" }) in server.ts caused 413 on large saves.
//   Route-level middleware here overrides it with 50 MB for project PATCH.
r.patch(
  "/api/projects/:id",
  express.json({ limit: "50mb" }),
  authenticate,
  async (req: Request, res: Response) => {
    const projectId = req.params.id;
    const uid       = (req as any).user.uid;
    try {
      const authz = makeProjectAuthz(pool);
      const owned = await authz.getOwnedProject(projectId, uid);
      if (!owned) return res.status(403).json({ error: "forbidden" });
      const { op } = req.body ?? {};
      const { version } = await applyStatePatch(pool, projectId, op ?? req.body);
      await pool.query(
        `INSERT INTO project_events (project_id, user_id, event_type, payload, version)
         VALUES ($1, $2, $3, $4, $5)`,
        [projectId, uid, op?.type ?? "GENERAL_UPDATE", JSON.stringify(op?.payload ?? req.body), version],
      );
      res.json({ success: true, version });
    } catch (err: any) {
      if (err.code === "CONFLICT") return res.status(409).json({ error: "version_conflict", ...err });
      logger.error({ err }, "PATCH /api/projects/:id failed");
      res.status(500).json({ error: err.message });
    }
  },
);

r.delete("/api/projects/:id", authenticate, async (req: Request, res: Response) => {
  try {
    const authz = makeProjectAuthz(pool);
    const owned = await authz.getOwnedProject(req.params.id, (req as any).user.uid);
    if (!owned) return res.status(403).json({ error: "forbidden" });
    await pool.query("DELETE FROM projects WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public / Remix ──────────────────────────────────────────────────────────

r.get("/api/public/projects/:id", async (req: Request, res: Response) => {
  try {
    const { rows: [project] } = await pool.query(
      "SELECT id, name, bpm FROM projects WHERE id = $1", [req.params.id],
    );
    if (!project) return res.status(404).json({ error: "not_found" });
    const { rows: [state] } = await pool.query(
      "SELECT state_json FROM project_states WHERE project_id = $1", [req.params.id],
    );
    res.json({ ...project, state: state?.state_json ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

r.post("/api/projects/:id/remix", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user.uid;
    const { rows: [src] } = await pool.query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
    if (!src) return res.status(404).json({ error: "not_found" });
    const { rows: [srcState] } = await pool.query(
      "SELECT state_json, ydoc FROM project_states WHERE project_id = $1", [req.params.id],
    );
    const newId = uuidv4();
    await pool.query(
      "INSERT INTO projects (id, name, user_id, bpm) VALUES ($1, $2, $3, $4)",
      [newId, `Remix of ${src.name}`, uid, src.bpm],
    );
    await pool.query(
      "INSERT INTO project_states (project_id, state_json, ydoc, version) VALUES ($1, $2, $3, 0)",
      [newId, srcState?.state_json ?? null, srcState?.ydoc ?? Buffer.alloc(0)],
    );
    res.status(201).json({ id: newId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Media Upload ─────────────────────────────────────────────────────────────
// BUG-01 / BUG-02 FIX: Accepts all video, audio, image, document, archive types.
// Streams to GCS — no disk temp files.

const gcs    = new Storage();
const BUCKET = process.env.GCS_BUCKET ?? "sonicwave-media";

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
        if (!responded) { responded = true; res.status(415).json({ error: "unsupported_media_type", mimeType }); }
        return;
      }
      const objectName  = `uploads/${uuidv4()}-${filename}`;
      const writeStream = gcs.bucket(BUCKET).file(objectName).createWriteStream({
        metadata: { contentType: mimeType }, resumable: false,
      });
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > policy.maxBytes) {
          stream.destroy(); writeStream.destroy();
          if (!responded) { responded = true; res.status(413).json({ error: "file_too_large", maxBytes: policy.maxBytes }); }
        }
      });
      stream.pipe(writeStream);
      writeStream.on("finish", () => {
        if (!responded) {
          responded = true;
          res.json({ fileUrl: `https://storage.googleapis.com/${BUCKET}/${objectName}`, fileName: filename, mimeType, label: policy.label, objectName });
        }
      });
      writeStream.on("error", (err: Error) => {
        logger.error({ err }, "GCS write error");
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
  const filename    = (req.headers["x-file-name"] as string) ?? "upload";
  const objectName  = `uploads/${uuidv4()}-${filename}`;
  const writeStream = gcs.bucket(BUCKET).file(objectName).createWriteStream({ metadata: { contentType }, resumable: true });
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > policy.maxBytes) {
      req.destroy(); writeStream.destroy();
      if (!res.headersSent) res.status(413).json({ error: "file_too_large", maxBytes: policy.maxBytes });
    }
  });
  req.pipe(writeStream);
  writeStream.on("finish", () => {
    if (!res.headersSent)
      res.json({ fileUrl: `https://storage.googleapis.com/${BUCKET}/${objectName}`, fileName: filename, mimeType: contentType, label: policy.label, objectName });
  });
  writeStream.on("error", (err: Error) => {
    logger.error({ err }, "GCS write error (raw)");
    if (!res.headersSent) res.status(500).json({ error: "upload_failed" });
  });
});

// ─── Job Queues ──────────────────────────────────────────────────────────────

r.post("/api/jobs/render", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user.uid;
    const { projectId, format = "wav", quality = "high" } = req.body ?? {};
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    const job = await audioQueue.add("render", { projectId, uid, format, quality });
    res.status(202).json({ jobId: job.id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

r.get("/api/jobs/:jobId", authenticate, async (req: Request, res: Response) => {
  try {
    const job = await audioQueue.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: "not_found" });
    res.json({ jobId: job.id, state: await job.getState(), progress: job.progress, result: job.returnvalue });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

r.post("/api/jobs/ai", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user.uid;
    const job = await aiQueue.add("ai-generate", { uid, ...req.body });
    res.status(202).json({ jobId: job.id });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Stripe Billing ──────────────────────────────────────────────────────────

import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", { apiVersion: "2024-04-10" });

r.post("/api/billing/create-checkout", authenticate, async (req: Request, res: Response) => {
  try {
    const { priceId } = req.body ?? {};
    if (!priceId) return res.status(400).json({ error: "priceId required" });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: "subscription",
      success_url: `${req.headers.origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${req.headers.origin}/billing/cancel`,
      client_reference_id: (req as any).user.uid,
    });
    res.json({ url: session.url });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

r.get("/api/billing/subscription", authenticate, async (req: Request, res: Response) => {
  try {
    const uid = (req as any).user.uid;
    const { rows: [customer] } = await pool.query(
      "SELECT stripe_customer_id FROM users WHERE uid = $1", [uid],
    );
    if (!customer?.stripe_customer_id) return res.json({ plan: "FREE" });
    const subs = await stripe.subscriptions.list({
      customer: customer.stripe_customer_id, status: "active", limit: 1,
    });
    res.json(subs.data[0] ?? { plan: "FREE" });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

r.post(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig    = req.headers["stripe-signature"] as string;
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err: any) {
      logger.warn({ err }, "Stripe webhook signature mismatch");
      return res.status(400).json({ error: "invalid_signature" });
    }
    try {
      await pool.query("INSERT INTO processed_webhooks (event_id) VALUES ($1)", [event.id]);
    } catch {
      return res.json({ received: true, skipped: true });
    }
    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          await pool.query(
            "UPDATE users SET subscription_status = $1, plan = $2 WHERE stripe_customer_id = $3",
            [sub.status, sub.items.data[0]?.price?.nickname ?? "paid", sub.customer as string],
          );
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          await pool.query(
            "UPDATE users SET subscription_status = 'canceled', plan = 'FREE' WHERE stripe_customer_id = $1",
            [sub.customer as string],
          );
          break;
        }
      }
      res.json({ received: true });
    } catch (err: any) {
      logger.error({ err }, "Webhook handler error");
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Admin: Run Migrations ────────────────────────────────────────────────────
// BUG-04 FIX:
//   Old code hardcoded filenames ("001_init", "002_ai_tracks") — broke if
//   files had different names. Fix: dynamic readdirSync prefix scan.

const MIGRATE_SECRET = process.env.MIGRATE_SECRET;

r.post("/api/admin/migrate", async (req: Request, res: Response) => {
  if (!MIGRATE_SECRET) return res.status(404).json({ error: "not_found" });
  if (req.headers["x-migrate-secret"] !== MIGRATE_SECRET)
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
    await pool.query(sql);
    logger.info({ migration, file: matchFile }, "Migration applied");
    res.json({ success: true, file: matchFile });
  } catch (err: any) {
    logger.error({ err, migration }, "Migration failed");
    res.status(500).json({ error: err.message });
  }
});

export default r;
