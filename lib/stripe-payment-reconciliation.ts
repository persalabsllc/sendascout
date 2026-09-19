import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, payments } from "@/db/schema";
import { reportOperationalEvent } from "@/lib/observability";
import { paymentErrorDiagnostic } from "@/lib/payment-presentation";
import { getStripe, getStripeLivemode, stripeObjectId } from "@/lib/stripe";
import { recordPaymentIntentState, recordSuccessfulPaymentIntent } from "@/lib/stripe-payments";

const unsettled = ["pending", "requires_action", "processing", "authorized", "failed", "canceled"] as const;

// Retrieve only existing Stripe objects. This function never creates a Checkout
// Session or charges a card. Publication uses the same verified, atomic path as
// the signed webhook; cancellation/refund and genuine support holds stay intact.
export async function reconcileBookingPayment(paymentId: string, customerId?: string) {
  const db = getDb();
  const [payment] = await db.select().from(payments).where(and(
    eq(payments.id, paymentId), eq(payments.kind, "booking"),
    customerId ? eq(payments.customerId, customerId) : undefined,
  )).limit(1);
  if (!payment) throw new Error("Booking payment not found.");
  if (payment.livemode !== getStripeLivemode()) throw new Error("Payment mode does not match this environment.");
  if (unsettled.includes(payment.status as typeof unsettled[number])) {
    const stripe = getStripe();
    let intentId = payment.stripePaymentIntentId;
    if (payment.stripeCheckoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
      if (session.livemode !== payment.livemode
        || stripeObjectId(session.customer) !== payment.stripeCustomerId
        || session.amount_total !== payment.amountCents || session.currency !== payment.currency
        || session.metadata?.sendascout_payment_id !== payment.id
        || session.metadata?.sendascout_mission_id !== payment.missionId
        || session.metadata?.sendascout_customer_id !== payment.customerId
        || session.metadata?.sendascout_payment_kind !== "booking") throw new Error("Checkout identity does not match this booking.");
      const sessionIntentId = stripeObjectId(session.payment_intent);
      // The stored Checkout Session is authoritative for this booking attempt.
      // Never fall back to a different, stale PaymentIntent.
      if (sessionIntentId) intentId = sessionIntentId;
      else intentId = null;
    }
    if (intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ["latest_charge.balance_transaction"] });
      if (intent.livemode !== payment.livemode
        || intent.metadata.sendascout_payment_id !== payment.id
        || intent.metadata.sendascout_mission_id !== payment.missionId
        || intent.metadata.sendascout_customer_id !== payment.customerId
        || intent.metadata.sendascout_payment_kind !== "booking"
        || stripeObjectId(intent.customer) !== payment.stripeCustomerId
        || intent.amount !== payment.amountCents || intent.currency !== payment.currency
        || intent.transfer_group !== payment.stripeTransferGroup) throw new Error("PaymentIntent identity does not match this booking.");
      if (intent.status === "succeeded") await recordSuccessfulPaymentIntent(intent, payment.stripeCheckoutSessionId);
      else await recordPaymentIntentState(intent);
    }
    // Rotate the bounded sweep fairly, including abandoned checkout sessions.
    // Do not disturb the separate in-flight Checkout creation lease.
    await db.update(payments).set({ updatedAt: new Date() }).where(and(
      eq(payments.id, payment.id), sql`${payments.failureCode} IS DISTINCT FROM 'checkout_creating'`,
      inArray(payments.status, [...unsettled]),
    ));
  }
  const [current] = await db.select({ status: payments.status, missionStatus: missions.status })
    .from(payments).innerJoin(missions, eq(missions.id, payments.missionId)).where(eq(payments.id, payment.id)).limit(1);
  console.info("Booking payment reconciled", { paymentId: payment.id, missionId: payment.missionId, ...current });
  return { paymentId: payment.id, missionId: payment.missionId, ...current };
}

export async function reconcilePendingBookingPayments(limit = 25) {
  const db = getDb();
  const candidates = await db.select({ id: payments.id, missionId: payments.missionId })
    .from(payments).innerJoin(missions, eq(missions.id, payments.missionId)).where(and(
      eq(payments.kind, "booking"), eq(payments.livemode, getStripeLivemode()),
      inArray(payments.status, [...unsettled]), isNull(payments.paidAt),
      eq(missions.status, "draft"), isNull(missions.archivedAt),
      or(isNotNull(payments.stripeCheckoutSessionId), isNotNull(payments.stripePaymentIntentId)),
      sql`${payments.failureCode} IS DISTINCT FROM 'checkout_creating'`,
      sql`${payments.createdAt} > now() - interval '30 days'`,
    )).orderBy(asc(payments.updatedAt)).limit(limit);
  let confirmed = 0;
  let errors = 0;
  for (const payment of candidates) {
    try {
      const result = await reconcileBookingPayment(payment.id);
      if (result.status === "paid") confirmed++;
    } catch (error) {
      errors++;
      const diagnostic = paymentErrorDiagnostic(error);
      await reportOperationalEvent({ category: "booking_payment_confirmation", message: diagnostic.message, fingerprint: `booking-confirmation:${payment.id}`, context: { paymentId: payment.id, missionId: payment.missionId, code: diagnostic.code } });
    }
  }
  return { checked: candidates.length, confirmed, errors };
}
