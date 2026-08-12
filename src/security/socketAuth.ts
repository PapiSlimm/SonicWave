/**
 * Socket authorization decision — the fix for the CRITICAL finding.
 *
 * The original wsServer.ts read `userId` and `projectId` straight from the
 * connection query string and joined the room with NO token check and NO
 * ownership check, so any client could join any project's room and read/inject
 * collaborative edits. This module makes the decision explicit, testable, and
 * fail-closed:
 *
 *   1. A valid Firebase ID token is REQUIRED (identity comes from the decoded
 *      token, never from the query string).
 *   2. The authenticated user must own the project (or be a shared collaborator)
 *      before the join is authorized.
 *
 * Dependencies are injected so this is unit-tested without firebase-admin or a
 * database.
 */

export interface DecodedToken {
  uid: string;
  email?: string;
}

export interface AuthorizeDeps {
  /** Verify a Firebase ID token; reject if invalid/expired. */
  verifyToken: (idToken: string) => Promise<DecodedToken>;
  /** Return the owner uid of a project, or null if it does not exist. */
  getProjectOwner: (projectId: string) => Promise<string | null>;
  /** Return true if `uid` is an accepted collaborator on `projectId`. */
  isCollaborator?: (projectId: string, uid: string) => Promise<boolean>;
}

export interface SocketHandshakeLike {
  auth?: { token?: unknown };
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

export type AuthorizeResult =
  | { ok: true; uid: string; projectId: string; role: "owner" | "collaborator" }
  | { ok: false; code: "NO_TOKEN" | "BAD_TOKEN" | "NO_PROJECT" | "NOT_FOUND" | "FORBIDDEN"; reason: string };

function extractToken(hs: SocketHandshakeLike): string | null {
  // Prefer the Socket.IO `auth` payload (not logged, not in the URL).
  const authToken = hs.auth?.token;
  if (typeof authToken === "string" && authToken.length > 0) return authToken;
  // Accept an Authorization header as a fallback.
  const header = hs.headers?.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return null;
}

function extractProjectId(hs: SocketHandshakeLike): string | null {
  const p = hs.auth?.token && typeof hs.query?.projectId === "string" ? hs.query.projectId : hs.query?.projectId;
  return typeof p === "string" && p.length > 0 ? p : null;
}

export async function authorizeSocket(
  hs: SocketHandshakeLike,
  deps: AuthorizeDeps,
): Promise<AuthorizeResult> {
  const token = extractToken(hs);
  if (!token) return { ok: false, code: "NO_TOKEN", reason: "Missing auth token" };

  const projectId = extractProjectId(hs);
  if (!projectId) return { ok: false, code: "NO_PROJECT", reason: "Missing projectId" };

  let decoded: DecodedToken;
  try {
    decoded = await deps.verifyToken(token);
  } catch {
    return { ok: false, code: "BAD_TOKEN", reason: "Invalid or expired token" };
  }
  if (!decoded?.uid) return { ok: false, code: "BAD_TOKEN", reason: "Token has no uid" };

  const owner = await deps.getProjectOwner(projectId);
  if (owner === null) return { ok: false, code: "NOT_FOUND", reason: "Project not found" };

  if (owner === decoded.uid) {
    return { ok: true, uid: decoded.uid, projectId, role: "owner" };
  }
  if (deps.isCollaborator && (await deps.isCollaborator(projectId, decoded.uid))) {
    return { ok: true, uid: decoded.uid, projectId, role: "collaborator" };
  }
  return { ok: false, code: "FORBIDDEN", reason: "Not authorized for this project" };
}
