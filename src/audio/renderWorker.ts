/**
 * BullMQ audio render worker — runs the real ffmpeg mix and uploads the result
 * to object storage. Replaces the original worker's setTimeout progress loop and
 * fabricated `/exports/...wav` URL.
 *
 * Storage and job runner are injected. `runRender` is the core; the BullMQ
 * `Worker` wiring at the bottom is thin.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMixArgs, type ProjectMix } from "./renderCommand.ts";

export interface StoragePort {
  /** Fetch a stored asset to a local temp path (returns the local path). */
  fetchToLocal: (src: string) => Promise<string>;
  /** Upload a local file, return a durable, access-controlled URL/key. */
  upload: (localPath: string, key: string) => Promise<string>;
}

export interface RenderDeps {
  storage: StoragePort;
  loadProjectMix: (projectId: string) => Promise<ProjectMix>;
  onProgress?: (pct: number) => void | Promise<void>;
  ffmpegPath?: string; // default "ffmpeg"
}

export interface RenderResult {
  key: string;
  url: string;
  bytes: number;
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

export async function runRender(
  projectId: string,
  jobId: string,
  deps: RenderDeps,
): Promise<RenderResult> {
  const ffmpeg = deps.ffmpegPath ?? "ffmpeg";
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `render-${jobId}-`));
  try {
    const mix = await deps.loadProjectMix(projectId);

    // Materialize remote clips locally, rewriting src to local paths.
    for (const track of mix.tracks) {
      for (const clip of track.clips) {
        clip.src = await deps.storage.fetchToLocal(clip.src);
      }
    }
    await deps.onProgress?.(25);

    const outPath = path.join(workDir, `${jobId}-master.wav`);
    const plan = buildMixArgs(mix, outPath);
    await runFfmpeg(ffmpeg, plan.args);
    await deps.onProgress?.(80);

    const stat = await fs.stat(outPath);
    const key = `exports/${projectId}/${jobId}-master.wav`;
    const url = await deps.storage.upload(outPath, key);
    await deps.onProgress?.(100);

    return { key, url, bytes: stat.size };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Thin BullMQ wiring. Import and call from server bootstrap with real deps.
 * (Kept out of the pure module so tests don't need Redis.)
 */
export function createRenderWorker(WorkerCtor: any, connection: unknown, deps: RenderDeps) {
  return new WorkerCtor(
    "audio-processing",
    async (job: any) => {
      const result = await runRender(job.data.projectId, String(job.id), {
        ...deps,
        onProgress: (pct) => job.updateProgress(pct),
      });
      return result; // { key, url, bytes } — a REAL artifact, persisted
    },
    { connection, concurrency: 2, limiter: { max: 10, duration: 1000 } },
  );
}
