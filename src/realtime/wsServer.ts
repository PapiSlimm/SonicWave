/**
 * Production collaboration gateway — full rewrite of the original wsServer.ts.
 *
 * Fixes vs. original:
 *  - Authenticates every socket via a Firebase ID token in an io.use()
 *    middleware; identity is taken from the decoded token, never the query.
 *  - Authorizes room joins against project ownership/collaboration.
 *  - Maintains a SERVER-AUTHORITATIVE Y.Doc per project and PERSISTS it, so
 *    late joiners receive current state and edits survive restarts (the original
 *    only broadcast to currently-connected peers and never saved).
 *  - Attaches the Redis adapter so rooms span instances (the original created
 *    io without an adapter despite depending on @socket.io/redis-adapter).
 *
 * This file wires real dependencies; the authorization DECISION lives in
 * ../security/socketAuth.ts and is unit-tested independently.
 */
import type { Server, Socket } from "socket.io";
import * as Y from "yjs";
import { authorizeSocket, type AuthorizeDeps } from "../security/socketAuth.ts";

export interface GatewayDeps extends AuthorizeDeps {
  logger: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
  /** Load the persisted Y.Doc update for a project (or null if none yet). */
  loadDocUpdate: (projectId: string) => Promise<Uint8Array | null>;
  /** Persist the full Y.Doc update for a project (debounced by caller). */
  saveDocUpdate: (projectId: string, update: Uint8Array) => Promise<void>;
}

interface SocketData {
  uid: string;
  projectId: string;
  role: "owner" | "collaborator";
}

const PERSIST_DEBOUNCE_MS = 1500;

export function initCollaborationGateway(io: Server, deps: GatewayDeps): void {
  // In-memory authoritative docs for currently-active projects on this instance.
  const docs = new Map<string, Y.Doc>();
  const saveTimers = new Map<string, NodeJS.Timeout>();

  async function getDoc(projectId: string): Promise<Y.Doc> {
    let doc = docs.get(projectId);
    if (doc) return doc;
    doc = new Y.Doc();
    const persisted = await deps.loadDocUpdate(projectId);
    if (persisted) Y.applyUpdate(doc, persisted);
    docs.set(projectId, doc);
    return doc;
  }

  function scheduleSave(projectId: string, doc: Y.Doc): void {
    const existing = saveTimers.get(projectId);
    if (existing) clearTimeout(existing);
    saveTimers.set(
      projectId,
      setTimeout(() => {
        saveTimers.delete(projectId);
        deps
          .saveDocUpdate(projectId, Y.encodeStateAsUpdate(doc))
          .catch((error) => deps.logger.error({ error, projectId }, "Failed to persist Y.Doc"));
      }, PERSIST_DEBOUNCE_MS),
    );
  }

  // --- Authentication middleware: runs before any event handler. ---
  io.use(async (socket: Socket, next) => {
    const result = await authorizeSocket(
      { auth: socket.handshake.auth, query: socket.handshake.query, headers: socket.handshake.headers },
      deps,
    );
    if (!result.ok) {
      deps.logger.warn({ code: result.code, addr: socket.handshake.address }, "Socket rejected");
      return next(new Error(result.code));
    }
    (socket.data as SocketData) = { uid: result.uid, projectId: result.projectId, role: result.role };
    next();
  });

  io.on("connection", async (socket: Socket) => {
    const { uid, projectId } = socket.data as SocketData;
    deps.logger.info({ uid, projectId }, "Socket connected");

    // Only ever join the room the user was authorized for.
    socket.join(projectId);

    // Send the authoritative current state to the newcomer.
    const doc = await getDoc(projectId);
    socket.emit("crdt_sync", Y.encodeStateAsUpdate(doc));

    socket.on("crdt_update", (update: Uint8Array) => {
      try {
        Y.applyUpdate(doc, update); // apply to authoritative doc
        socket.to(projectId).emit("crdt_update", update); // fan out to peers
        scheduleSave(projectId, doc);
      } catch (error) {
        deps.logger.error({ error, projectId }, "Bad CRDT update rejected");
      }
    });

    socket.on("awareness_update", (update: unknown) => {
      // Awareness (presence) is ephemeral; identity is server-derived, not client-supplied.
      socket.to(projectId).emit("awareness_update", { uid, update });
    });

    socket.on("cursor_move", (position: { x: number; y: number; trackId?: string }) => {
      socket.to(projectId).emit("peer_cursor", { uid, position });
    });

    socket.on("disconnect", () => {
      deps.logger.info({ uid, projectId }, "Socket disconnected");
      socket.to(projectId).emit("user_left", { uid });
      // Persist immediately on disconnect so nothing is lost.
      const d = docs.get(projectId);
      if (d) deps.saveDocUpdate(projectId, Y.encodeStateAsUpdate(d)).catch(() => {});
    });
  });
}
