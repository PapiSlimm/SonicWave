/**
 * queues.ts — BullMQ queue singletons for SonicWave.
 *
 * Exports:
 *   audioQueue  — render / mixdown jobs
 *   aiQueue     — AI generation jobs
 *
 * Both queues accept an optional IORedis connection so tests can inject
 * a mock connection. In production server.ts passes the shared Redis
 * connection it creates from REDIS_URL.
 */
import { Queue } from "bullmq";
import type { RedisOptions } from "ioredis";
import IORedis from "ioredis";

// ─── Connection factory ───────────────────────────────────────────────────────

let _sharedConnection: IORedis | null = null;

function getDefaultConnection(): IORedis {
  if (_sharedConnection) return _sharedConnection;
  const url  = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set — cannot initialise BullMQ queues");
  _sharedConnection = new IORedis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck:      false,
  });
  return _sharedConnection;
}

// ─── Queue factory ────────────────────────────────────────────────────────────

export function makeQueues(connection?: IORedis) {
  const conn = connection ?? getDefaultConnection();

  const audioQueue = new Queue("audio-render", {
    connection: conn,
    defaultJobOptions: {
      attempts:    3,
      backoff:     { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 200 },
    },
  });

  const aiQueue = new Queue("ai-generate", {
    connection: conn,
    defaultJobOptions: {
      attempts:    2,
      backoff:     { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 200 },
    },
  });

  return { audioQueue, aiQueue };
}

// ─── Process-level singletons (for direct imports) ───────────────────────────
// server.ts calls makeQueues() with its own connection; these singletons exist
// so modules that import from this file without DI still compile.
const _default = makeQueues();
export const audioQueue = _default.audioQueue;
export const aiQueue    = _default.aiQueue;
