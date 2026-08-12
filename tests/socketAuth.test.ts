import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeSocket, type AuthorizeDeps } from "../src/security/socketAuth.ts";

const goodDeps = (owner: string): AuthorizeDeps => ({
  verifyToken: async (t) => {
    if (t === "valid-owner") return { uid: owner };
    if (t === "valid-other") return { uid: "intruder" };
    throw new Error("bad token");
  },
  getProjectOwner: async (pid) => (pid === "p1" ? owner : null),
  isCollaborator: async (_pid, uid) => uid === "friend",
});

test("rejects a socket with NO token (the original vulnerability)", async () => {
  const r = await authorizeSocket({ query: { projectId: "p1", userId: "anyone" } }, goodDeps("owner1"));
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "NO_TOKEN");
});

test("rejects an invalid token", async () => {
  const r = await authorizeSocket({ auth: { token: "garbage" }, query: { projectId: "p1" } }, goodDeps("owner1"));
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "BAD_TOKEN");
});

test("rejects a valid user who does NOT own or collaborate (cross-project block)", async () => {
  const r = await authorizeSocket({ auth: { token: "valid-other" }, query: { projectId: "p1" } }, goodDeps("owner1"));
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "FORBIDDEN");
});

test("identity comes from the TOKEN, not the query string", async () => {
  // Query claims userId 'owner1' but token decodes to 'intruder' → forbidden.
  const r = await authorizeSocket(
    { auth: { token: "valid-other" }, query: { projectId: "p1", userId: "owner1" } },
    goodDeps("owner1"),
  );
  assert.equal(r.ok, false);
});

test("allows the real owner", async () => {
  const r = await authorizeSocket({ auth: { token: "valid-owner" }, query: { projectId: "p1" } }, goodDeps("owner1"));
  assert.equal(r.ok, true);
  assert.equal((r as any).role, "owner");
  assert.equal((r as any).uid, "owner1");
});

test("allows an accepted collaborator", async () => {
  const deps = goodDeps("owner1");
  deps.verifyToken = async () => ({ uid: "friend" });
  const r = await authorizeSocket({ auth: { token: "x" }, query: { projectId: "p1" } }, deps);
  assert.equal(r.ok, true);
  assert.equal((r as any).role, "collaborator");
});

test("returns NOT_FOUND for a missing project", async () => {
  const r = await authorizeSocket({ auth: { token: "valid-owner" }, query: { projectId: "nope" } }, goodDeps("owner1"));
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "NOT_FOUND");
});
