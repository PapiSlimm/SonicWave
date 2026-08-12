/**
 * Stripe webhook handler — the fix for "real checkout but no webhook, so paid
 * status is never persisted."
 *
 * The original had no webhook at all and re-derived the plan on every request by
 * listing Stripe customers by email. Here:
 *   - The raw body + signature are verified by the caller (route mounts
 *     express.raw BEFORE express.json and calls stripe.webhooks.constructEvent).
 *   - Processing is IDEMPOTENT: each event id is recorded, and a duplicate
 *     delivery (Stripe retries!) is a no-op.
 *   - Entitlements are PERSISTED to our own store, so authz never depends on a
 *     live Stripe round-trip.
 *
 * The Stripe SDK and DB are injected so the logic is unit-testable.
 */

export type Plan = "FREE" | "PRO" | "ENTERPRISE";

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export interface WebhookDeps {
  /** Returns true if this event id was already processed (idempotency). */
  alreadyProcessed: (eventId: string) => Promise<boolean>;
  /** Atomically record the event id as processed. Should be unique-constrained. */
  markProcessed: (eventId: string, type: string) => Promise<void>;
  /** Persist the user's entitlement. */
  setEntitlement: (uid: string, plan: Plan, opts: { subscriptionId?: string; currentPeriodEnd?: number }) => Promise<void>;
  /** Map a Stripe customer id -> our uid (stored when the checkout session was created). */
  resolveUid: (args: { customerId?: string; clientReferenceId?: string | null }) => Promise<string | null>;
  /** Map a Stripe price id -> our plan. */
  planForPrice: (priceId: string) => Plan;
  logger: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

export interface HandleResult {
  handled: boolean;
  duplicate: boolean;
  action?: string;
}

export async function handleStripeEvent(event: StripeEventLike, deps: WebhookDeps): Promise<HandleResult> {
  if (await deps.alreadyProcessed(event.id)) {
    deps.logger.info({ eventId: event.id }, "Duplicate webhook ignored");
    return { handled: true, duplicate: true };
  }

  let action: string | undefined;

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const uid = await deps.resolveUid({ customerId: s.customer, clientReferenceId: s.client_reference_id });
      if (uid) {
        // Full entitlement is granted on subscription events; here we at least
        // link the customer. Plan is confirmed by subscription.created/updated.
        action = "checkout_linked";
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const uid = await deps.resolveUid({ customerId: sub.customer });
      const priceId: string | undefined = sub.items?.data?.[0]?.price?.id;
      if (uid && priceId) {
        const active = sub.status === "active" || sub.status === "trialing";
        const plan: Plan = active ? deps.planForPrice(priceId) : "FREE";
        await deps.setEntitlement(uid, plan, {
          subscriptionId: sub.id,
          currentPeriodEnd: sub.current_period_end,
        });
        action = `entitlement:${plan}`;
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const uid = await deps.resolveUid({ customerId: sub.customer });
      if (uid) {
        await deps.setEntitlement(uid, "FREE", { subscriptionId: sub.id });
        action = "entitlement:FREE";
      }
      break;
    }
    default:
      action = "ignored";
  }

  // Record AFTER handling so a crash mid-processing lets Stripe retry.
  await deps.markProcessed(event.id, event.type);
  return { handled: true, duplicate: false, action };
}
