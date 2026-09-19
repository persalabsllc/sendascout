import { sql } from "drizzle-orm";
import { payments } from "@/db/schema";

export const bookingConfirmationFailed = sql<boolean>`(
  ${payments.kind} = 'booking'
  AND ${payments.status} NOT IN ('paid', 'partially_refunded', 'refunded', 'disputed')
  AND EXISTS (
    SELECT 1 FROM stripe_webhook_events AS confirmation_event
    WHERE confirmation_event.scope = 'platform'
      AND confirmation_event.livemode = ${payments.livemode}
      AND confirmation_event.status = 'failed'
      AND confirmation_event.type IN ('checkout.session.completed', 'checkout.session.async_payment_succeeded', 'payment_intent.succeeded')
      AND confirmation_event.object_id IN (${payments.stripeCheckoutSessionId}, ${payments.stripePaymentIntentId})
  )
)`;
