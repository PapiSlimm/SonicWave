/**
 * V12 FEED INTAKE — universal drop-in receiver for ecosystem feed events.
 *
 * Copy this file into any V12 app and mount it BEFORE express.json():
 *
 *     import { createFeedIntake } from './v12-feed-intake.ts';
 *     app.use('/api/ecosystem/feed', createFeedIntake({ serviceId: 'ceos' }));
 *
 * Endpoints:
 *     POST /events  — signed ecosystem envelopes (V12-Signature, raw body)
 *     GET  /inbox   — most recent accepted events (for the app's feed UI)
 *
 * Contract: the envelope + V12-Signature scheme from the ecosystem contract
 * (same construction as src/ecosystem/v12-webhook.ts — Stripe-style
 * `t=<unix>,v1=<hex hmac-sha256 over "t.rawBody">`).
 *
 * Secrets: the sender signs with the key it shares with THIS app. On receipt
 * we try, in order: V12_<SENDER>_WEBHOOK_SECRET, V12_<SELF>_WEBHOOK_SECRET,
 * V12_WEBHOOK_SECRET, ECOSYSTEM_SECRET. This tolerates both per-pair keys and
 * the simple same-secret-everywhere deployment. No configured secret = every
 * request is refused (fail-closed) — never accept unsigned traffic.
 *
 * Durability: accepted events append to ecosystem-inbox.jsonl (path
 * configurable) and dedupe on envelope id, so at-least-once delivery does not
 * double-post. Pass `onEvent` to ingest events into the app's own feed or
 * marketplace tables.
 *
 * Self-contained: express + node built-ins only.
 */
import express, { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── V12-Signature verification (vendored construction — do not alter) ───────

function verifySignature(secret: string, rawBody: string, header: string, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Envelope (contract v1.x, dependency-free validation) ────────────────────

export interface FeedEnvelope {
  id: string;
  type: string;
  version: string;
  source: string;
  occurredAt: string;
  correlationId?: string;
  subjectUserId?: string;
  payload: unknown;
}

const SERVICE_ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

function validateEnvelope(raw: unknown): { ok: true; env: FeedEnvelope } | { ok: false; error: string } {
  const e = raw as Partial<FeedEnvelope> | null;
  if (!e || typeof e !== 'object') return { ok: false, error: 'Body is not an object' };
  if (typeof e.id !== 'string' || e.id.length < 8 || e.id.length > 120) return { ok: false, error: 'Bad envelope id' };
  if (typeof e.type !== 'string' || e.type.length < 3 || e.type.length > 80) return { ok: false, error: 'Bad envelope type' };
  if (typeof e.version !== 'string' || !/^\d+\.\d+$/.test(e.version)) return { ok: false, error: 'Bad envelope version' };
  if (e.version.split('.')[0] !== '1') return { ok: false, error: `Incompatible contract version ${e.version}` };
  if (typeof e.source !== 'string' || !SERVICE_ID_PATTERN.test(e.source)) return { ok: false, error: 'Bad envelope source' };
  if (typeof e.occurredAt !== 'string' || Number.isNaN(Date.parse(e.occurredAt))) return { ok: false, error: 'Bad occurredAt' };
  return { ok: true, env: e as FeedEnvelope };
}

// ── Intake factory ──────────────────────────────────────────────────────────

export interface FeedIntakeOptions {
  /** This app's service id, e.g. "ceos", "apexatlas", "orion-prime". */
  serviceId: string;
  /** Override secret resolution. Default: env lookup described above. */
  secretsFor?: (senderId: string) => string[];
  /** Where accepted events persist. Default: ./ecosystem-inbox.jsonl */
  inboxFile?: string;
  /** App-specific ingestion (create feed post, marketplace listing, ...). */
  onEvent?: (env: FeedEnvelope) => void | Promise<void>;
  /** Max events kept in the in-memory inbox served by GET /inbox. */
  inboxLimit?: number;
}

function envKey(id: string): string {
  return id.toUpperCase().replace(/-/g, '_');
}

export function createFeedIntake(opts: FeedIntakeOptions): Router {
  const router = Router();
  const inboxFile = opts.inboxFile ?? path.join(process.cwd(), 'ecosystem-inbox.jsonl');
  const inboxLimit = opts.inboxLimit ?? 200;
  const seen = new Set<string>();
  const inbox: FeedEnvelope[] = [];

  // Warm dedupe + inbox from disk so restarts do not double-apply.
  try {
    if (fs.existsSync(inboxFile)) {
      const lines = fs.readFileSync(inboxFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-2000)) {
        try {
          const env = JSON.parse(line) as FeedEnvelope;
          if (env?.id) { seen.add(env.id); inbox.push(env); }
        } catch { /* skip corrupt line */ }
      }
      while (inbox.length > inboxLimit) inbox.shift();
    }
  } catch (err) {
    console.warn(`[feed-intake:${opts.serviceId}] could not warm inbox:`, err);
  }

  const secretsFor = opts.secretsFor ?? ((senderId: string) =>
    [
      process.env[`V12_${envKey(senderId)}_WEBHOOK_SECRET`],
      process.env[`V12_${envKey(opts.serviceId)}_WEBHOOK_SECRET`],
      process.env.V12_WEBHOOK_SECRET,
      process.env.ECOSYSTEM_SECRET,
    ].filter((s): s is string => typeof s === 'string' && s.length >= 32));

  // Raw body parser scoped to this router only — the HMAC covers exact bytes.
  router.post('/events', express.raw({ type: '*/*', limit: '256kb' }), async (req: Request, res: Response) => {
    const sender = req.headers['x-v12-service'];
    const sig = req.headers['v12-signature'];
    if (typeof sender !== 'string' || !SERVICE_ID_PATTERN.test(sender) || typeof sig !== 'string') {
      return res.status(400).json({ error: 'Missing X-V12-Service or V12-Signature (t=<unix>,v1=<hex>).' });
    }

    const candidates = secretsFor(sender);
    if (candidates.length === 0) {
      // Fail closed: no secret, no intake — never accept unsigned traffic.
      return res.status(401).json({ error: `No webhook secret configured for ${sender} on ${opts.serviceId}.` });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!rawBody) return res.status(400).json({ error: 'Empty or non-raw body.' });
    if (!candidates.some((s) => verifySignature(s, rawBody, sig))) {
      return res.status(401).json({ error: 'Signature verification failed.' });
    }

    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Body is not valid JSON.' }); }
    const v = validateEnvelope(parsed);
    if (!v.ok) return res.status(422).json({ error: v.error });
    const env = v.env;

    if (env.source !== sender) {
      return res.status(422).json({ error: `Envelope source "${env.source}" does not match X-V12-Service "${sender}".` });
    }

    // At-least-once delivery → dedupe before any side effect.
    if (seen.has(env.id)) return res.json({ received: true, duplicate: true });
    seen.add(env.id);

    inbox.push(env);
    while (inbox.length > inboxLimit) inbox.shift();
    try { fs.appendFileSync(inboxFile, JSON.stringify(env) + '\n'); }
    catch (err) { console.error(`[feed-intake:${opts.serviceId}] inbox persist failed:`, err); }

    try {
      await opts.onEvent?.(env);
      res.json({ received: true, handled: !!opts.onEvent });
    } catch (err) {
      console.error(`[feed-intake:${opts.serviceId}] onEvent failed for ${env.type}:`, err);
      // Event is stored + deduped; report handled:false rather than 5xx so the
      // sender does not retry into the dedupe wall.
      res.json({ received: true, handled: false });
    }
  });

  router.get('/inbox', (_req: Request, res: Response) => {
    res.json({ service: opts.serviceId, count: inbox.length, events: [...inbox].reverse() });
  });

  return router;
}
