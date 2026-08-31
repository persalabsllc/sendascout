import type Stripe from "stripe";
import { processConnectedStripeEvent } from "@/lib/stripe-connected-events";
import { getStripe, getStripeLivemode } from "@/lib/stripe";
import { isStripeV2Event } from "@/lib/stripe-webhooks";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Stripe Connect webhook signature is missing." }, { status: 400 });

  const rawBody = await request.text();
  let event: Stripe.Event | Stripe.V2.Core.EventNotification;
  try {
    const payload = JSON.parse(rawBody) as { object?: unknown };
    const thin = payload.object === "v2.core.event";
    const secret = (thin
      ? process.env.STRIPE_CONNECT_THIN_WEBHOOK_SECRET
      : process.env.STRIPE_CONNECT_SNAPSHOT_WEBHOOK_SECRET
    )?.trim();
    if (!secret) {
      return Response.json({ error: `Stripe Connect ${thin ? "thin" : "snapshot"} webhook verification is not configured.` }, { status: 503 });
    }
    event = thin
      ? getStripe().parseEventNotification(rawBody, signature, secret)
      : getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return Response.json({ error: "Invalid Stripe webhook signature." }, { status: 400 });
  }

  if (event.livemode !== getStripeLivemode()) {
    return Response.json({ error: "Stripe Connect webhook mode does not match this environment." }, { status: 400 });
  }

  try {
    const status = await processConnectedStripeEvent(event);
    return Response.json({ received: true, status });
  } catch (error) {
    console.error("Stripe Connect webhook processing failed", {
      eventId: event.id,
      eventType: event.type,
      account: isStripeV2Event(event)
        ? ("related_object" in event ? event.related_object?.id ?? null : null)
        : event.account ?? event.context ?? null,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
