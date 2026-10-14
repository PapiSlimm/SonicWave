/**
 * auth.ts — Firebase ID-token verification middleware.
 *
 * Expects a Bearer token in the Authorization header. Attaches
 * req.user = { uid, email } on success; responds 401 on failure.
 *
 * Designed for dependency-injection: makeAuthMiddleware accepts any
 * verifyFn so tests can swap in a fake. The named `authenticate` export
 * uses firebase-admin and is what server.ts passes as verifyToken.
 */
import type { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin";
import { logger } from "../lib/logger.js";

export interface AuthUser {
  uid: string;
  email?: string;
}

// Augment Express so downstream handlers see req.user without casts.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export type VerifyTokenFn = (token: string) => Promise<AuthUser>;

/**
 * Factory: create an Express middleware that uses `verify` to validate
 * the Bearer token. Attaches req.user on success.
 */
export function makeAuthMiddleware(verify: VerifyTokenFn) {
  return async function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const header = req.headers.authorization ?? "";
    const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      res.status(401).json({ error: "missing_token" });
      return;
    }

    try {
      req.user = await verify(token);
      next();
    } catch (err: any) {
      logger.warn({ err: err?.message }, "auth: token verification failed");
      res.status(401).json({ error: "invalid_token" });
    }
  };
}

/**
 * Default verifyToken implementation backed by firebase-admin.
 * Lazily initialises the Admin SDK (idempotent).
 */
export async function verifyFirebaseToken(token: string): Promise<AuthUser> {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId:  process.env.FIREBASE_PROJECT_ID,
    });
  }
  const decoded = await admin.auth().verifyIdToken(token);
  return { uid: decoded.uid, email: decoded.email };
}

/**
 * Ready-to-use middleware wired to Firebase.
 * Pass this as `verifyToken` in createRoutes(), or import `authenticate`
 * directly where you need per-route protection.
 */
export const authenticate = makeAuthMiddleware(verifyFirebaseToken);
