/**
 * src/storage/s3.ts
 *
 * S3-compatible storage adapter — works with:
 *   - AWS S3            (leave AWS_ENDPOINT_URL unset)
 *   - Cloudflare R2     (AWS_ENDPOINT_URL=https://<acct>.r2.cloudflarestorage.com)
 *   - MinIO / any S3 shim
 *
 * Implements StoragePort from renderWorker.ts:
 *   fetchToLocal(src)         — download a stored object to a local temp file
 *   upload(localPath, key)    — stream a local file to S3, return a presigned GET URL
 *
 * Also exports:
 *   createS3UploadStream(key, contentType) — writable stream for route-level uploads
 *   getPublicUrl(key)                       — build the public/CDN URL for an object
 */

import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createWriteStream, createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, PassThrough, type Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { StoragePort } from "../audio/renderWorker.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional: set for R2, MinIO, etc. Leave undefined for AWS S3. */
  endpointUrl?: string;
  /**
   * Public base URL for objects.
   * For AWS S3 public buckets: https://<bucket>.s3.<region>.amazonaws.com
   * For Cloudflare R2 + custom domain: https://cdn.yourdomain.com
   * For presigned URLs set to undefined — getPublicUrl() will return a signed URL instead.
   */
  publicBaseUrl?: string;
  /** Presigned URL TTL in seconds (default 3600 = 1 hour) */
  signedUrlTtlSecs?: number;
}

// ── Client factory ────────────────────────────────────────────────────────────

export function createS3Client(cfg: S3Config): S3Client {
  return new S3Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    ...(cfg.endpointUrl
      ? {
          endpoint: cfg.endpointUrl,
          forcePathStyle: true, // required for R2 and most S3-shims
        }
      : {}),
  });
}

// ── S3 Storage adapter ────────────────────────────────────────────────────────

export class S3Storage implements StoragePort {
  private client: S3Client;
  private cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
    this.client = createS3Client(cfg);
  }

  /**
   * Download an S3 object to a local temp file.
   * `src` may be:
   *   - A storage key:  "uploads/abc-track.wav"
   *   - An https URL:   "https://bucket.s3.us-east-1.amazonaws.com/uploads/abc.wav"
   *     (the key is extracted automatically)
   */
  async fetchToLocal(src: string): Promise<string> {
    const key = extractKey(src, this.cfg);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sw-fetch-"));
    const localPath = path.join(tmpDir, path.basename(key));

    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
    if (!resp.Body) throw new Error(`S3 GetObject returned empty body for key: ${key}`);

    const body = resp.Body as Readable;
    await pipeline(body, createWriteStream(localPath));
    return localPath;
  }

  /**
   * Stream a local file to S3 using multipart upload (handles files of any size).
   * Returns a public or presigned URL for the uploaded object.
   */
  async upload(localPath: string, key: string): Promise<string> {
    const fileStream = createReadStream(localPath);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: key,
        Body: fileStream,
        // Objects are private; callers get a presigned or CDN URL
      },
      queueSize: 4,   // 4 parallel part uploads
      partSize: 8 * 1024 * 1024, // 8 MB parts
    });

    await upload.done();
    return this.getObjectUrl(key);
  }

  /**
   * Create a pass-through writable stream that uploads to S3 on-the-fly.
   * Use from routes to stream inbound HTTP bodies directly — no temp disk.
   *
   * Returns { stream, done }:
   *   - pipe your source into `stream`
   *   - await `done` to get the final URL after upload completes
   */
  createUploadStream(
    key: string,
    contentType: string,
  ): { stream: Writable; done: Promise<string> } {
    const pass = new PassThrough();

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.cfg.bucket,
        Key: key,
        Body: pass,
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });

    const done = upload.done().then(() => this.getObjectUrl(key));
    return { stream: pass, done };
  }

  /**
   * Delete a single object. Silently swallows NoSuchKey.
   */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    );
  }

  /**
   * Check whether an object exists.
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      );
      return true;
    } catch (e: any) {
      if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  }

  /**
   * Generate a presigned GET URL (default 1-hour TTL).
   * Use when objects are private and the caller needs temporary download access.
   */
  async presignGet(key: string, ttlSecs?: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { expiresIn: ttlSecs ?? this.cfg.signedUrlTtlSecs ?? 3600 },
    );
  }

  /**
   * Returns a public CDN URL when publicBaseUrl is set, otherwise a presigned URL.
   */
  async getObjectUrl(key: string): Promise<string> {
    if (this.cfg.publicBaseUrl) {
      return `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`;
    }
    return this.presignGet(key);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the S3 key from a full URL or pass it through if it's already a key.
 */
function extractKey(src: string, cfg: S3Config): string {
  if (!src.startsWith("http")) return src; // already a bare key

  const url = new URL(src);
  // Path-style: endpoint/bucket/key
  const bucketPrefix = `/${cfg.bucket}/`;
  if (url.pathname.startsWith(bucketPrefix)) {
    return decodeURIComponent(url.pathname.slice(bucketPrefix.length));
  }
  // Virtual-hosted style: bucket.s3.region.amazonaws.com/key
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

// ── Factory from environment ──────────────────────────────────────────────────

/**
 * Build an S3Storage from the standard environment variables.
 * Throws if any required variable is missing.
 */
export function createS3StorageFromEnv(): S3Storage {
  const bucket      = requireEnv("STORAGE_BUCKET");
  const region      = requireEnv("AWS_REGION");
  const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
  const endpointUrl = process.env.AWS_ENDPOINT_URL;     // optional (R2, MinIO)
  const publicBaseUrl = process.env.STORAGE_PUBLIC_URL; // optional CDN prefix

  return new S3Storage({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpointUrl,
    publicBaseUrl,
    signedUrlTtlSecs: 3600,
  });
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[storage] Missing required env var: ${key}`);
  return v;
}
