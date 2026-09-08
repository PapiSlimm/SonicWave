/**
 * AI Music Generation for the SonicWave DAW (MiniMax Music 3.0, 2026-09).
 *
 * POST /api/ai/generate-track
 *   Auth: Firebase bearer token (same identity the collab gateway trusts).
 *   Body: { projectId?, style, lyrics?, instrumental? }
 *   - Calls MiniMax's hosted music API (model music-3.0).
 *   - Stores the MP3 in Postgres (generated_tracks).
 *   - If projectId is given and the caller owns it or collaborates on it,
 *     appends the clip to the project's timeline state (project_states.state
 *     .tracks[]) so it appears in the DAW as a new track, and bumps version.
 *   Returns { trackId, audioUrl, title, addedToProject }.
 *
 * GET /api/ai/audio/:id
 *   Streams the generated audio (public-read by id; ids are unguessable).
 *
 * Gated on MINIMAX_API_KEY. Missing/PENDING key -> 503 with a clear message,
 * never a crash. Fail-closed on auth.
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";

export interface MusicGenDeps {
  db: { query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> };
  verifyToken: (token: string) => Promise<{ uid: string; email?: string }>;
  getProjectOwner: (projectId: string) => Promise<string | null>;
  isCollaborator: (projectId: string, uid: string) => Promise<boolean>;
  logger: { info: (o: any, m?: string) => void; error: (o: any, m?: string) => void };
}

const MAX_STYLE = 2000;
const MAX_LYRICS = 5000;

export function createMusicGen(deps: MusicGenDeps): Router {
  const r = Router();

  async function requireUser(req: Request, res: Response): Promise<{ uid: string } | null> {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) { res.status(401).json({ error: "missing_token" }); return null; }
    try { return await deps.verifyToken(token); }
    catch { res.status(401).json({ error: "invalid_token" }); return null; }
  }

  r.post("/api/ai/generate-track", async (req: Request, res: Response) => {
    const user = await requireUser(req, res);
    if (!user) return;

    const { projectId, style, lyrics, instrumental = true } = req.body || {};
    if (!style || typeof style !== "string") return res.status(400).json({ error: "style_required" });
    if (!instrumental && (!lyrics || typeof lyrics !== "string")) return res.status(400).json({ error: "lyrics_required_or_instrumental" });

    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey || apiKey === "PENDING") return res.status(503).json({ error: "not_configured", message: "AI track generation is not configured yet (MINIMAX_API_KEY missing)" });

    // Project access check BEFORE burning API credits.
    if (projectId) {
      const owner = await deps.getProjectOwner(projectId);
      if (!owner) return res.status(404).json({ error: "project_not_found" });
      if (owner !== user.uid && !(await deps.isCollaborator(projectId, user.uid))) {
        return res.status(403).json({ error: "not_project_member" });
      }
    }

    const body: Record<string, unknown> = {
      model: "music-3.0",
      prompt: String(style).slice(0, MAX_STYLE),
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: "mp3" },
    };
    if (instrumental) body.is_instrumental = true;
    else body.lyrics = String(lyrics).slice(0, MAX_LYRICS);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
    let mm: any;
    try {
      const resp = await fetch("https://api.minimax.io/v1/music_generation", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      mm = await resp.json();
    } catch (e: any) {
      deps.logger.error({ err: e?.message }, "minimax call failed");
      return res.status(502).json({ error: "generation_failed", message: e?.message || "network error" });
    } finally { clearTimeout(t); }

    if (mm?.base_resp?.status_code !== 0 || !mm?.data?.audio) {
      return res.status(502).json({ error: "generation_refused", message: mm?.base_resp?.status_msg || "no audio returned" });
    }

    const bytes = Buffer.from(mm.data.audio, "hex");
    const id = randomUUID();
    const title = (String(instrumental ? style : (String(lyrics || "").split("\n").find(l => l.trim() && !l.trim().startsWith("[")) || style)).slice(0, 80).trim()) || "AI Track";
    const durationMs = mm?.extra_info?.music_duration ?? null;

    await deps.db.query(
      `INSERT INTO generated_tracks (id, project_id, user_id, title, style_prompt, instrumental, mime, bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, 'audio/mpeg', $7, $8)`,
      [id, projectId || null, user.uid, title, String(style).slice(0, MAX_STYLE), !!instrumental, bytes, durationMs]
    );

    const audioUrl = `/api/ai/audio/${id}`;
    let addedToProject = false;

    if (projectId) {
      try {
        // Append the clip to the DAW timeline and bump the optimistic version.
        const { rows } = await deps.db.query<{ state: any; version: number }>(
          "SELECT state, version FROM project_states WHERE project_id = $1", [projectId]
        );
        const cur = rows[0];
        if (cur) {
          const state = cur.state || { tracks: [] };
          if (!Array.isArray(state.tracks)) state.tracks = [];
          state.tracks.push({
            id: `ai_${id}`,
            name: title,
            type: "audio",
            source: "ai-generated",
            src: audioUrl,
            durationMs,
            volume: 1,
            muted: false,
            clips: [{ id: `clip_${id}`, src: audioUrl, startMs: 0, offsetMs: 0, durationMs }],
          });
          await deps.db.query(
            "UPDATE project_states SET state = $1, version = version + 1, updated_at = now() WHERE project_id = $2",
            [JSON.stringify(state), projectId]
          );
          addedToProject = true;
        }
      } catch (e: any) {
        deps.logger.error({ err: e?.message }, "timeline append failed (track still saved)");
      }
    }

    deps.logger.info({ id, projectId: projectId || null, addedToProject }, "ai track generated");
    return res.json({ trackId: id, audioUrl, title, durationMs, addedToProject });
  });

  r.get("/api/ai/audio/:id", async (req: Request, res: Response) => {
    const { rows } = await deps.db.query<{ mime: string; bytes: Buffer }>(
      "SELECT mime, bytes FROM generated_tracks WHERE id = $1", [req.params.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", row.mime);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Accept-Ranges", "bytes");
    return res.end(row.bytes);
  });

  return r;
}
