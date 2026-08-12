import { test } from "node:test";
import assert from "node:assert/strict";
import { handleStripeEvent, type WebhookDeps, type StripeEventLike } from "../src/billing/webhookHandler.ts";

function makeDeps(overrides: Partial<WebhookDeps> = {}) {
  const processed = new Set<string>();
  const entitlements = new Map<string, string>();
  const deps: WebhookDeps = {
    alreadyProcessed: async (id) => processed.has(id),
    markProcessed: async (id) => void processed.add(id),
    setEntitlement: async (uid, plan) => void entitlements.set(uid, plan),
    resolveUid: async ({ customerId, clientReferenceId }) =>
      clientReferenceId ?? (customerId === "cus_1" ? "user-1" : null),
    planForPrice: (price) => (price === "price_pro" ? "PRO" : "FREE"),
    logger: { info: () => {}, warn: () => {} },
    ...overrides,
  };
  return { deps, processed, entitlements };
}

const subEvent = (status: string): StripeEventLike => ({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1", customer: "cus_1", status, current_period_end: 111, items: { data: [{ price: { id: "price_pro" } }] } } },
});

test("subscription.updated (active) persists PRO entitlement", async () => {
  const { deps, entitlements } = makeDeps();
  const r = await handleStripeEvent(subEvent("active"), deps);
  assert.equal(r.handled, true);
  assert.equal(r.duplicate, false);
  assert.equal(entitlements.get("user-1"), "PRO");
});

test("inactive subscription downgrades to FREE", async () => {
  const { deps, entitlements } = makeDeps();
  await handleStripeEvent(subEvent("past_due"), deps);
  assert.equal(entitlements.get("user-1"), "FREE");
});

test("subscription.deleted revokes to FREE", async () => {
  const { deps, entitlements } = makeDeps();
  await handleStripeEvent(
    { id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1" } } },
    deps,
  );
  assert.equal(entitlements.get("user-1"), "FREE");
});

test("IDEMPOTENT: a duplicate event id is a no-op (Stripe retries safely)", async () => {
  const { deps, entitlements } = makeDeps();
  await handleStripeEvent(subEvent("active"), deps);
  entitlements.set("user-1", "TAMPERED"); // simulate drift
  const second = await handleStripeEvent(subEvent("active"), deps);
  assert.equal(second.duplicate, true);
  assert.equal(entitlements.get("user-1"), "TAMPERED"); // not re-processed
});

test("unknown event types are acknowledged, not crashed", async () => {
  const { deps } = makeDeps();
  const r = await handleStripeEvent({ id: "evt_x", type: "invoice.paid", data: { object: {} } }, deps);
  assert.equal(r.handled, true);
  assert.equal(r.action, "ignored");
});
