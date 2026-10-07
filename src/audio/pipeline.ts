/**
 * src/audio/pipeline.ts
 *
 * OSS Multimedia Pipeline — SonicWave Production
 * ================================================
 * Framework choice: FFmpeg (not GStreamer, not LibVLC)
 *
 * Justification:
 *   - GStreamer: superior IPC (GstBus, appsrc/appsink), but Node.js bindings
 *     (node-gstreamer-superficial, gstreamer-js) are unmaintained and break
 *     on node:22-slim. Native addon compile fails headless in Docker without
 *     build-essential + gstreamer1.0-dev (~400 MB extra image size).
 *   - LibVLC: playback-first; no encoder/muxer control at frame level.
 *   - FFmpeg: 1 binary, every codec, DASH/HLS native, zero native addon.
 *     Runs on node:22-slim after `apt-get install ffmpeg` (Dockerfile already
 *     does this). fluent-ffmpeg wrapper is optional; we use child_process
 *     directly for full flag control.
 *
 * IPC Strategy:
 *   Frames/streams travel via UNIX domain sockets (UDS).
 *   - Parent opens a UDS server at /tmp/sw-{jobId}.sock
 *   - FFmpeg spawned with `-i unix:///tmp/sw-{jobId}.sock`
 *   - Node.js Readable pipes into the UDS connection FFmpeg opens
 *   - FFmpeg writes muxed output to stdout (pipe:1)
 *   - stdout Readable piped directly to GCS/S3 upload → zero temp disk
 *   - UDS avoids TCP port collisions in multi-worker Docker environments
 *
 * Failure & Edge Case Strategies:
 *   1. Dropped frames: -vsync vfr — FFmpeg timestamps surviving frames.
 *   2. A/V sync drift: -af aresample=async=1000 corrects drift ≤1000 samples.
 *      For live input also add -fflags +genpts+igndts.
 *   3. Dynamic bitrate: 3-rung DASH ladder in transcode.sh; ABR player adapts.
 *   4. Process crash: BullMQ job retries (maxAttempts:3, exponential backoff).
 *   5. OOM on 4K: -threads 2 per worker; BullMQ concurrency=2 per pod.
 */

import { spawn, ChildProcess } from "child_process";
import { createServer, Server as NetServer } from "net";
import { pipeline, Readable } from "stream";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { unlink, mkdir } from "fs/promises";
import path from "path";
import os from "os";

const pipelineAsync = promisify(pipeline);

// ---- Types ----------------------------------------------------------------

export interface PipelineInput {
  /** Raw PCM stream: s16le, stereo, 44100 Hz */
  audioStream?: Readable;
  /** Raw YUV420p video stream (optional — audio-only jobs skip video) */
  videoStream?: Readable;
  /** Duration hint in seconds (for progress % calculation) */
  durationSecs?: number;
  /** Sample rate of incoming audio (default 44100) */
  sampleRate?: number;
}

export interface PipelineOutput {
  /** Muxed output stream — pipe to S3/GCS upload or fs.WriteStream */
  outputStream: Readable;
  /** Abort the pipeline immediately (SIGTERM to FFmpeg) */
  abort(): void;
  /** Resolves on clean exit (code 0); rejects on error */
  done: Promise<void>;
}

export interface TranscodeOptions {
  /** Output container/format */
  format: "dash" | "mp4" | "webm" | "mp3";
  videoCodec?: "libx264" | "libsvtav1" | "copy";
  audioCodec?: "aac" | "libopus" | "libmp3lame" | "copy";
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  resolution?: string;
  /** FFmpeg thread count per process (default 2; keep low per worker) */
  threads?: number;
  /** DASH segment duration seconds (default 4) */
  segmentDurationSecs?: number;
}

// ---- Core -----------------------------------------------------------------

/**
 * spawnFfmpegPipeline
 *
 * Equivalent copy-pasteable CLI:
 *   ffmpeg -f s16le -ar 44100 -ac 2 -i unix:///tmp/sw-<id>.sock \
 *     -vn -c:a libopus -b:a 192k -vbr on -compression_level 10 \
 *     -af "aresample=async=1000" -f webm pipe:1
 */
export async function spawnFfmpegPipeline(
  input: PipelineInput,
  opts: TranscodeOptions,
): Promise<PipelineOutput> {
  const jobId = randomUUID();
  const sockPath = path.join(os.tmpdir(), `sw-${jobId}.sock`);
  const args = buildFfmpegArgs(sockPath, input, opts);
  const udsServer = await startUdsServer(sockPath, input);

  const ffProc: ChildProcess = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  ffProc.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    // Parse progress time= from FFmpeg stats output
    if (input.durationSecs) {
      const m = /time=(\d{2}):(\d{2}):(\d{2}\.\d+)/.exec(chunk.toString());
      if (m) {
        const secs = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
        const pct = Math.min(100, Math.round((secs / input.durationSecs) * 100));
        ffProc.emit("progress", pct);
      }
    }
  });

  const done = new Promise<void>((resolve, reject) => {
    ffProc.on("close", async (code) => {
      udsServer.close();
      await safeUnlink(sockPath);
      if (code === 0) resolve();
      else {
        const stderr = Buffer.concat(stderrChunks).toString().slice(-2000);
        reject(new Error(`FFmpeg exited ${code}:\n${stderr}`));
      }
    });
    ffProc.on("error", async (err) => {
      udsServer.close();
      await safeUnlink(sockPath);
      reject(err);
    });
  });

  return {
    outputStream: ffProc.stdout as Readable,
    abort: () => ffProc.kill("SIGTERM"),
    done,
  };
}

// ---- UDS Server -----------------------------------------------------------

/**
 * IPC: Node Readable → UDS write end → [kernel socket buffer] → FFmpeg stdin
 *
 * Why UDS over stdin pipe?
 * FFmpeg needs seekable input for some formats. UDS opens as a file descriptor
 * in FFmpeg, avoiding stdin's non-seekable constraint.
 */
async function startUdsServer(
  sockPath: string,
  input: PipelineInput,
): Promise<NetServer> {
  await mkdir(path.dirname(sockPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      const src = input.audioStream ?? (input.videoStream as Readable);
      if (!src) { socket.destroy(new Error("No input stream")); return; }
      pipelineAsync(src, socket).catch(() => {
        // EPIPE expected: FFmpeg closes connection when it finishes reading
      });
    });
    server.listen(sockPath, () => resolve(server));
    server.once("error", reject);
  });
}

// ---- Arg Builder ----------------------------------------------------------

function buildFfmpegArgs(
  sockPath: string,
  input: PipelineInput,
  opts: TranscodeOptions,
): string[] {
  const {
    format, videoCodec = "libsvtav1", audioCodec = "libopus",
    videoBitrateKbps = 2000, audioBitrateKbps = 128,
    resolution = "1920x1080", threads = 2, segmentDurationSecs = 4,
  } = opts;

  const sampleRate = input.sampleRate ?? 44100;
  const hasVideo = !!input.videoStream;

  const a: string[] = [
    "-hide_banner", "-loglevel", "warning", "-stats",
    "-fflags", "+genpts+igndts", "-threads", String(threads),
    "-f", "s16le", "-ar", String(sampleRate), "-ac", "2",
    "-i", `unix://${sockPath}`,
    "-af", "aresample=async=1000",
  ];

  if (hasVideo) {
    a.push("-c:v", videoCodec, "-b:v", `${videoBitrateKbps}k`, "-s", resolution, "-vsync", "vfr");
    if (videoCodec === "libsvtav1") {
      a.push("-preset", "6", "-crf", "28",
             "-svtav1-params", "tune=0:film-grain=8",
             "-g", String(segmentDurationSecs * 25));
    } else if (videoCodec === "libx264") {
      a.push("-preset", "fast", "-crf", "23", "-g", String(segmentDurationSecs * 25));
    }
  } else { a.push("-vn"); }

  a.push("-c:a", audioCodec, "-b:a", `${audioBitrateKbps}k`);
  if (audioCodec === "libopus") {
    a.push("-vbr", "on", "-compression_level", "10", "-frame_duration", "20");
  }

  switch (format) {
    case "dash":
      a.push("-f", "dash", "-seg_duration", String(segmentDurationSecs),
             "-use_timeline", "1", "-use_template", "1",
             "-adaptation_sets", "id=0,streams=a id=1,streams=v",
             "-dash_segment_type", "mp4", "pipe:1"); break;
    case "webm": a.push("-f", "webm", "pipe:1"); break;
    case "mp4":  a.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"); break;
    case "mp3":  a.push("-f", "mp3", "pipe:1"); break;
  }
  return a;
}

async function safeUnlink(p: string): Promise<void> {
  try { await unlink(p); } catch { /* ignore */ }
}

// ---- Audio-only shortcut --------------------------------------------------

/**
 * renderAudioTrack — PCM stream → Opus/MP3 output stream.
 * Used by renderWorker.ts.
 *
 * CLI equivalent:
 *   ffmpeg -f s16le -ar 44100 -ac 2 -i unix:///tmp/sw-<id>.sock \
 *     -vn -af "aresample=async=1000" \
 *     -c:a libopus -b:a 192k -vbr on -compression_level 10 -f webm pipe:1
 */
export async function renderAudioTrack(
  pcmStream: Readable,
  opts: Pick<TranscodeOptions, "audioCodec" | "audioBitrateKbps" | "format">,
): Promise<PipelineOutput> {
  return spawnFfmpegPipeline(
    { audioStream: pcmStream },
    {
      format: opts.format ?? "webm",
      audioCodec: opts.audioCodec ?? "libopus",
      audioBitrateKbps: opts.audioBitrateKbps ?? 192,
      threads: 1,
    },
  );
}
