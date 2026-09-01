import "server-only";

import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import { scoutProfiles, stripePayouts } from "@/db/schema";
import { syncStripeAccountById } from "@/lib/stripe-connect-service";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { reconcileCasePayouts, reconcileCompletedMissionSettlements } from "@/lib/stripe-settlement";
import { getStripe, getStripeLivemode } from "@/lib/stripe";
import { isStripeV2Event, withStripeWebhookLedger, type StripeWebhookEvent } from "@/lib/stripe-webhooks";

export async function processConnectedStripeEvent(event: StripeWebhookEvent) {
  const type = event.type as string;
  const scope = type.startsWith("v2.") ? "v2" : "connected";
  return withStripeWebhookLedger(event, scope, async () => {
    if (type === "account.updated" || v2AccountStateEvent(type)) {
      const accountId = isStripeV2Event(event)
        ? ("related_object" in event ? event.related_object?.id : null)
        : (event.data.object as { id?: string }).id ?? event.account;
      if (!accountId) return "ignored";
      const profile = await syncStripeAccountById(accountId);
      if (profile && scoutConnectReady(profile, getStripeLivemode())) {
        await reconcileCasePayouts();
        await reconcileCompletedMissionSettlements({ scoutId: profile.userId });
      }
      return "processed";
    }
    if (type === "balance_settings.updated") {
      if (isStripeV2Event(event)) return "ignored";
      const accountId = connectedAccountId(event);
      if (!accountId) return "ignored";
      const profile = await syncStripeAccountById(accountId);
      if (profile && scoutConnectReady(profile, getStripeLivemode())) {
        await reconcileCasePayouts();
        await reconcileCompletedMissionSettlements({ scoutId: profile.userId });
      }
      return "processed";
    }
    if (v2AccountLinkOrPersonEvent(type)) {
      if (!isStripeV2Event(event)) return "ignored";
      const accountId = await v2ParentAccountId(event);
      if (!accountId) throw new Error(`Stripe event ${event.id} did not identify its parent account.`);
      const profile = await syncStripeAccountById(accountId);
      if (profile && scoutConnectReady(profile, getStripeLivemode())) {
        await reconcileCasePayouts();
        await reconcileCompletedMissionSettlements({ scoutId: profile.userId });
      }
      return "processed";
    }
    if (["payout.created", "payout.updated", "payout.paid", "payout.failed", "payout.canceled"].includes(type)) {
      if (isStripeV2Event(event)) return "ignored";
      const accountId = connectedAccountId(event);
      if (!accountId) return "ignored";
      await recordConnectedPayout(accountId, event.data.object as Stripe.Payout);
      return "processed";
    }
    return "ignored";
  });
}

function connectedAccountId(event: Stripe.Event) {
  return event.account ?? (typeof event.context === "string" ? event.context : null);
}

function v2AccountStateEvent(type: string) {
  return type === "v2.core.account.updated"
    || type === "v2.core.account.closed"
    || type.startsWith("v2.core.account[configuration.recipient].")
    || type.startsWith("v2.core.account[requirements].")
    || type.startsWith("v2.core.account[future_requirements].")
    || type.startsWith("v2.core.account[identity].");
}

function v2AccountLinkOrPersonEvent(type: string) {
  return type === "v2.core.account_link.returned"
    || type === "v2.core.account_person.created"
    || type === "v2.core.account_person.updated"
    || type === "v2.core.account_person.deleted";
}

async function v2ParentAccountId(event: Stripe.V2.Core.EventNotification) {
  const fullEvent = await event.fetchEvent() as { data?: { account_id?: unknown } };
  return typeof fullEvent.data?.account_id === "string" && fullEvent.data.account_id
    ? fullEvent.data.account_id
    : null;
}

async function recordConnectedPayout(accountId: string, payout: Stripe.Payout) {
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.stripeAccountId, accountId)).limit(1);
  if (!profile) return null;
  const current = await getStripe().payouts.retrieve(payout.id, {}, { stripeContext: accountId });
  const livemode = getStripeLivemode();
  if (profile.stripeAccountLivemode !== livemode || current.livemode !== livemode) {
    throw new Error("Connected payout mode does not match the Scout payout account.");
  }
  const status = payoutStatus(current.status);
  const method = current.method === "instant" ? "instant" : "standard";
  const now = new Date();
  const values: typeof stripePayouts.$inferInsert = {
    scoutProfileId: profile.id,
    stripeAccountId: accountId,
    stripePayoutId: current.id,
    amountCents: current.amount,
    currency: current.currency,
    method,
    automatic: current.automatic,
    status,
    arrivalAt: current.arrival_date ? new Date(current.arrival_date * 1000) : null,
    failureCode: current.failure_code,
    failureMessage: current.failure_message,
    createdAt: new Date(current.created * 1000),
    updatedAt: now,
  };
  await db.insert(stripePayouts).values(values).onConflictDoUpdate({
    target: stripePayouts.stripePayoutId,
    set: {
      amountCents: values.amountCents,
      status,
      method,
      automatic: values.automatic,
      arrivalAt: values.arrivalAt,
      failureCode: values.failureCode,
      failureMessage: values.failureMessage,
      updatedAt: now,
    },
  });
  return { payoutId: current.id, status };
}

function payoutStatus(status: string): typeof stripePayouts.$inferInsert.status {
  if (status === "in_transit" || status === "paid" || status === "failed" || status === "canceled") return status;
  return "pending";
}
