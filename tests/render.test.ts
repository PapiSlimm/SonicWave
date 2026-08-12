import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMixArgs } from "../src/audio/renderCommand.ts";

test("empty project yields a silent-file command, not a fake string", () => {
  const plan = buildMixArgs({ tracks: [] }, "/tmp/out.wav");
  assert.equal(plan.inputs.length, 0);
  assert.ok(plan.args.includes("anullsrc=r=48000:cl=stereo"));
});

test("skips muted tracks and delays clips to their start time", () => {
  const plan = buildMixArgs(
    {
      tracks: [
        { id: "t1", gainDb: -3, clips: [{ id: "c1", src: "/a.wav", startTime: 0 }] },
        { id: "t2", muted: true, clips: [{ id: "c2", src: "/b.wav", startTime: 5 }] },
        { id: "t3", clips: [{ id: "c3", src: "/c.wav", startTime: 2.5 }] },
      ],
    },
    "/tmp/out.wav",
  );
  assert.equal(plan.inputs.length, 2); // muted track excluded
  const fg = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
  assert.ok(fg.includes("volume=-3dB"));
  assert.ok(fg.includes("adelay=2500:all=1")); // 2.5s -> 2500ms
  assert.ok(fg.includes("alimiter")); // master limiter present
});

// Integration: actually run ffmpeg end-to-end and verify a real WAV comes out.
test("REAL ffmpeg render produces a valid non-empty WAV", async (t) => {
  const which = await new Promise<boolean>((res) => {
    const p = spawn("ffmpeg", ["-version"]);
    p.on("error", () => res(false));
    p.on("close", (c) => res(c === 0));
  });
  if (!which) return t.skip("ffmpeg not installed");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rtest-"));
  const inA = path.join(dir, "a.wav");
  const inB = path.join(dir, "b.wav");
  const out = path.join(dir, "master.wav");

  // Generate two real 1s tones as inputs.
  const gen = (file: string, freq: number) =>
    new Promise<void>((res, rej) => {
      const p = spawn("ffmpeg", ["-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`, "-c:a", "pcm_s16le", "-y", file]);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error("gen failed"))));
    });
  await gen(inA, 440);
  await gen(inB, 660);

  const plan = buildMixArgs(
    { tracks: [{ id: "t1", clips: [{ id: "c1", src: inA, startTime: 0 }, { id: "c2", src: inB, startTime: 0.5 }] }] },
    out,
  );
  await new Promise<void>((res, rej) => {
    const p = spawn("ffmpeg", plan.args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(err.slice(-400)))));
  });

  const stat = await fs.stat(out);
  assert.ok(stat.size > 1000, `expected a real WAV, got ${stat.size} bytes`);
  // Verify it's a RIFF/WAVE file, not a placeholder string.
  const fd = await fs.open(out, "r");
  const buf = Buffer.alloc(12);
  await fd.read(buf, 0, 12, 0);
  await fd.close();
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  await fs.rm(dir, { recursive: true, force: true });
});
