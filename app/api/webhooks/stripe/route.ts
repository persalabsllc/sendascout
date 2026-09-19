import { getStripe, getStripeLivemode } from "@/lib/stripe";
import { processPlatformStripeEvent } from "@/lib/stripe-webhooks";
import { reportOperationalEvent } from "@/lib/observability";
import { paymentErrorDiagnostic } from "@/lib/payment-presentation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!signature || !secret) return Response.json({ error: "Stripe webhook verification is not configured." }, { status: 503 });

  const rawBody = await request.text();
  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    return Response.json({ error: "Invalid Stripe webhook signature." }, { status: 400 });
  }

  if (event.livemode !== getStripeLivemode()) {
    return Response.json({ error: "Stripe webhook mode does not match this environment." }, { status: 400 });
  }
  if (event.account || event.context) {
    return Response.json({ error: "Connected-account events must use the Stripe Connect webhook destination." }, { status: 400 });
  }

  try {
    const status = await processPlatformStripeEvent(event);
    return Response.json({ received: true, status });
  } catch (error) {
    const diagnostic = paymentErrorDiagnostic(error);
    await reportOperationalEvent({
      category: "stripe_webhook_confirmation",
      message: `Stripe ${event.type} could not be applied. ${diagnostic.message}`,
      fingerprint: `stripe-webhook:${event.id}`,
      context: { eventId: event.id, eventType: event.type, code: diagnostic.code },
    });
    return Response.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
