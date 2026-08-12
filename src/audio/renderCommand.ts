/**
 * Real audio render — the fix for the simulated worker + "WAV data would be
 * here" download placeholder.
 *
 * `buildMixArgs` turns a project's tracks/clips into a concrete ffmpeg argument
 * vector that mixes every clip at its start offset, applies per-track gain, and
 * writes a mastered WAV. It is a PURE function so the exact filtergraph is
 * unit-tested without spawning ffmpeg. The worker (renderWorker.ts) runs it.
 */

export interface Clip {
  id: string;
  src: string; // absolute path or storage-fetched local path
  startTime: number; // seconds
}
export interface Track {
  id: string;
  gainDb?: number; // per-track gain in dB (default 0)
  muted?: boolean;
  clips: Clip[];
}
export interface ProjectMix {
  tracks: Track[];
  sampleRate?: number; // default 48000
  masterGainDb?: number; // default 0
}

export interface MixPlan {
  inputs: string[]; // ordered input file paths
  args: string[]; // full ffmpeg argument vector (excluding the leading "ffmpeg")
  outputPath: string;
}

/**
 * Build an ffmpeg command that:
 *  - loads each non-muted clip as an input,
 *  - delays it to its startTime with `adelay`,
 *  - applies per-track gain with `volume`,
 *  - sums everything with `amix`,
 *  - applies master gain and a limiter, and
 *  - writes a 24-bit WAV at the target sample rate.
 */
export function buildMixArgs(project: ProjectMix, outputPath: string): MixPlan {
  const sampleRate = project.sampleRate ?? 48000;
  const masterGainDb = project.masterGainDb ?? 0;

  const inputs: string[] = [];
  const filters: string[] = [];
  const mixLabels: string[] = [];

  for (const track of project.tracks) {
    if (track.muted) continue;
    const gainDb = track.gainDb ?? 0;
    for (const clip of track.clips) {
      const idx = inputs.length;
      inputs.push(clip.src);
      const delayMs = Math.max(0, Math.round(clip.startTime * 1000));
      const label = `a${idx}`;
      // adelay needs a per-channel list; "all=1" applies to every channel.
      const parts = [`[${idx}:a]`];
      const chain: string[] = [];
      if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
      if (gainDb !== 0) chain.push(`volume=${gainDb}dB`);
      if (chain.length === 0) chain.push("anull");
      filters.push(`${parts.join("")}${chain.join(",")}[${label}]`);
      mixLabels.push(`[${label}]`);
    }
  }

  if (inputs.length === 0) {
    // Nothing to render — produce a short silent file rather than a fake string.
    const args = [
      "-f", "lavfi", "-t", "1", "-i", `anullsrc=r=${sampleRate}:cl=stereo`,
      "-c:a", "pcm_s24le", "-y", outputPath,
    ];
    return { inputs: [], args, outputPath };
  }

  const inputArgs = inputs.flatMap((p) => ["-i", p]);
  const masterChain = [
    `amix=inputs=${mixLabels.length}:normalize=0`,
    ...(masterGainDb !== 0 ? [`volume=${masterGainDb}dB`] : []),
    "alimiter=limit=0.98", // brickwall to prevent clipping
    `aresample=${sampleRate}`,
  ].join(",");
  const filtergraph = `${filters.join(";")};${mixLabels.join("")}${masterChain}[out]`;

  const args = [
    ...inputArgs,
    "-filter_complex", filtergraph,
    "-map", "[out]",
    "-c:a", "pcm_s24le",
    "-ar", String(sampleRate),
    "-y", outputPath,
  ];
  return { inputs, args, outputPath };
}
