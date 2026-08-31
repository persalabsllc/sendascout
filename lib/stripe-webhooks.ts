import "server-only";

import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import { stripeWebhookEvents } from "@/db/schema";
import {
  recordChargeRefunded,
  recordCheckoutSessionExpired,
  recordCheckoutSessionPaid,
  recordDispute,
  recordPaymentIntentState,
  recordRefund,
} from "@/lib/stripe-payments";
import { getStripe, stripeObjectId } from "@/lib/stripe";

type WebhookScope = "platform" | "connected" | "v2";
export type StripeWebhookEvent = Stripe.Event | Stripe.V2.Core.EventNotification;

export function isStripeV2Event(event: StripeWebhookEvent): event is Stripe.V2.Core.EventNotification {
  return event.object === "v2.core.event";
}

export async function processPlatformStripeEvent(event: Stripe.Event) {
  return withStripeWebhookLedger(event, "platform", async () => {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status !== "paid") return "ignored";
        await recordCheckoutSessionPaid(session);
        return "processed";
      }
      case "checkout.session.expired":
        await recordCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session);
        return "processed";
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = stripeObjectId(session.payment_intent);
        if (paymentIntentId) {
          await recordPaymentIntentState(await getStripe().paymentIntents.retrieve(paymentIntentId));
        }
        return "processed";
      }
      case "payment_intent.created":
      case "payment_intent.processing":
      case "payment_intent.requires_action":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled":
      case "payment_intent.succeeded":
        await recordPaymentIntentState(event.data.object as Stripe.PaymentIntent);
        return "processed";
      case "charge.refunded": {
        const incoming = event.data.object as Stripe.Charge;
        const current = await getStripe().charges.retrieve(incoming.id);
        await recordChargeRefunded(current);
        return "processed";
      }
      case "refund.created":
      case "refund.updated":
      case "refund.failed":
        await recordRefund(event.data.object as Stripe.Refund);
        return "processed";
      case "charge.dispute.created":
      case "charge.dispute.updated":
      case "charge.dispute.closed": {
        const incoming = event.data.object as Stripe.Dispute;
        // Stripe does not guarantee webhook delivery order. Retrieve the current
        // provider object so an older event cannot regress a closed dispute.
        const current = await getStripe().disputes.retrieve(incoming.id, { expand: ["payment_intent"] });
        const recorded = await recordDispute(current, new Date(event.created * 1000));
        if (recorded) return "processed";
        const intent = typeof current.payment_intent === "object" ? current.payment_intent : null;
        if (intent?.metadata.sendascout_payment_id) {
          throw new Error(`Stripe dispute ${current.id} arrived before its Send a Scout payment could be linked.`);
        }
        return "ignored";
      }
      default:
        return "ignored";
    }
  });
}

export async function withStripeWebhookLedger(
  event: StripeWebhookEvent,
  scope: WebhookScope,
  handler: () => Promise<"processed" | "ignored">,
) {
  const db = getDb();
  const eventIdentity = stripeWebhookEventIdentity(event, scope);
  const now = new Date();
  const staleClaimBefore = new Date(now.getTime() - 5 * 60 * 1000);
  await db.insert(stripeWebhookEvents).values({
    eventId: event.id,
    type: event.type,
    scope,
    connectedAccountId: eventIdentity.connectedAccountId,
    objectId: eventIdentity.objectId,
    livemode: event.livemode,
    apiVersion: eventIdentity.apiVersion,
    eventCreatedAt: eventIdentity.createdAt,
  }).onConflictDoNothing({ target: stripeWebhookEvents.eventId });

  const [existing] = await db.select().from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.eventId, event.id)).limit(1);
  if (!existing) throw new Error(`Webhook event ${event.id} could not be recorded.`);
  if (
    existing.type !== event.type
    || existing.scope !== scope
    || existing.connectedAccountId !== eventIdentity.connectedAccountId
    || existing.livemode !== event.livemode
  ) {
    throw new Error(`Webhook event ${event.id} conflicts with its existing ledger identity.`);
  }
  if (existing.status === "processed" || existing.status === "ignored") return existing.status;

  const [claimed] = await db.update(stripeWebhookEvents).set({
    status: "processing",
    attemptCount: sql`${stripeWebhookEvents.attemptCount} + 1`,
    lastError: null,
    processedAt: null,
    updatedAt: now,
  }).where(and(
    eq(stripeWebhookEvents.eventId, event.id),
    or(
      inArray(stripeWebhookEvents.status, ["received", "failed"]),
      and(eq(stripeWebhookEvents.status, "processing"), lt(stripeWebhookEvents.updatedAt, staleClaimBefore)),
    ),
  )).returning({ attemptCount: stripeWebhookEvents.attemptCount });
  if (!claimed) throw new Error(`Webhook event ${event.id} is already being processed.`);

  try {
    const status = await handler();
    const [completed] = await db.update(stripeWebhookEvents).set({
      status,
      processedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(stripeWebhookEvents.eventId, event.id),
      eq(stripeWebhookEvents.status, "processing"),
      eq(stripeWebhookEvents.attemptCount, claimed.attemptCount),
    )).returning({ eventId: stripeWebhookEvents.eventId });
    if (!completed) throw new Error(`Webhook event ${event.id} processing claim was superseded.`);
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe webhook processing failed.";
    await db.update(stripeWebhookEvents).set({
      status: "failed",
      lastError: message.slice(0, 2000),
      updatedAt: new Date(),
    }).where(and(
      eq(stripeWebhookEvents.eventId, event.id),
      eq(stripeWebhookEvents.status, "processing"),
      eq(stripeWebhookEvents.attemptCount, claimed.attemptCount),
    ));
    throw error;
  }
}

function stripeWebhookEventIdentity(event: StripeWebhookEvent, scope: WebhookScope) {
  if (isStripeV2Event(event)) {
    const createdAt = new Date(event.created);
    if (Number.isNaN(createdAt.getTime())) throw new Error(`Stripe event ${event.id} has an invalid creation time.`);
    const relatedObject = "related_object" in event ? event.related_object : null;
    return {
      connectedAccountId: scope === "v2" ? relatedObject?.id ?? null : null,
      objectId: relatedObject?.id ?? null,
      apiVersion: null,
      createdAt,
    };
  }
  const object = event.data.object as { id?: string };
  return {
    connectedAccountId: event.account ?? (typeof event.context === "string" ? event.context : null),
    objectId: object.id ?? null,
    apiVersion: event.api_version ?? null,
    createdAt: new Date(event.created * 1000),
  };
}
