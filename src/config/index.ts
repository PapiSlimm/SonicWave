/**
 * Fail-CLOSED configuration.
 *
 * Replaces the original server.ts behaviour, which only `console.warn`ed on a
 * bad environment and then fell back to an in-memory Redis mock, an empty Stripe
 * key, and a hardcoded port. In production those "warnings" become silent
 * outages. Here, a missing or malformed required variable throws at boot so the
 * container never starts in a half-configured state.
 *
 * `loadConfig` is pure over its `env` argument so it can be unit-tested without
 * mutating `process.env`.
 */
import { z } from "zod";

const RAW = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Cloud Run / most PaaS inject PORT. Never hardcode it.
  PORT: z.coerce.number().int().positive().default(8080),

  // In production these are REQUIRED. In dev/test they may be absent.
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),

  // ── S3-compatible object storage ─────────────────────────────────────────
  // Required in production. Works with AWS S3, Cloudflare R2, MinIO, etc.
  STORAGE_BUCKET: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // Optional: set to e.g. https://<acct>.r2.cloudflarestorage.com for R2/MinIO
  AWS_ENDPOINT_URL: z.string().url().optional(),
  // Optional: CDN/public base URL prefix. When absent, presigned URLs are used.
  STORAGE_PUBLIC_URL: z.string().url().optional(),
  // ─────────────────────────────────────────────────────────────────────────

  // Exact allowed browser origins (comma-separated). No wildcards in prod.
  CORS_ORIGINS: z.string().default(""),

  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
});

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  port: number;
  databaseUrl?: string;
  redisUrl?: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  geminiApiKey?: string;
  // Storage
  storageBucket?: string;
  awsRegion?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsEndpointUrl?: string;
  storagePublicUrl?: string;
  // Misc
  corsOrigins: string[];
  firebaseProjectId?: string;
}

/**
 * In production the following are non-negotiable; their absence is a boot error.
 */
const REQUIRED_IN_PROD: (keyof AppConfig)[] = [
  "databaseUrl",
  "redisUrl",
  "stripeSecretKey",
  "stripeWebhookSecret",
  "storageBucket",
  "awsRegion",
  "awsAccessKeyId",
  "awsSecretAccessKey",
];

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = RAW.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`[config] Invalid environment:\n${issues}`);
  }
  const e = parsed.data;

  const cfg: AppConfig = {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    geminiApiKey: e.GEMINI_API_KEY,
    storageBucket: e.STORAGE_BUCKET,
    awsRegion: e.AWS_REGION,
    awsAccessKeyId: e.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    awsEndpointUrl: e.AWS_ENDPOINT_URL,
    storagePublicUrl: e.STORAGE_PUBLIC_URL,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    firebaseProjectId: e.FIREBASE_PROJECT_ID,
  };

  if (cfg.isProduction) {
    const missing = REQUIRED_IN_PROD.filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(
        `[config] Missing required production variables: ${missing.join(", ")}. ` +
          `Refusing to start in a degraded state.`,
      );
    }
    if (cfg.corsOrigins.length === 0) {
      throw new Error(
        "[config] CORS_ORIGINS must list explicit origins in production (no wildcard).",
      );
    }
    if (cfg.corsOrigins.includes("*")) {
      throw new Error("[config] Wildcard CORS origin '*' is not allowed in production.");
    }
  }

  return cfg;
}
