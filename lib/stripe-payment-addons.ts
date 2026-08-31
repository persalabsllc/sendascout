import "server-only";

import { and, asc, eq, isNull, lt, or, sum } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import { missionChangeOrders, missionReviews, missions, payments } from "@/db/schema";
import {
  createHostedCheckoutForPayment,
  applyPaidAddonPayment,
  recordPaymentIntentState,
  recordSuccessfulPaymentIntent,
} from "@/lib/stripe-payments";
import {
  ENHANCED_REPORT_CUSTOMER_CENTS,
  ENHANCED_REPORT_SCOUT_CENTS,
  meetPriceForMinutes,
} from "@/lib/mission-pricing-core";
import { getStripe, getStripeLivemode, stripeObjectId } from "@/lib/stripe";

type AddonKind = "meet_adjustment" | "change_order" | "tip";

const OFF_SESSION_CREATING_CODE = "off_session_creating";
const OFF_SESSION_OUTCOME_UNKNOWN_CODE = "off_session_outcome_unknown";
const OFF_SESSION_TERMINAL_CODE = "off_session_invalid_request";
const OFF_SESSION_CREATE_STALE_MS = 5 * 60 * 1000;
const AMBIGUOUS_STRIPE_CREATE_ERROR_TYPES = new Set([
  "StripeConnectionError",
  "StripeAPIError",
  "StripeRateLimitError",
]);

export type AddonPaymentInput = {
  kind: AddonKind;
  missionId: string;
  customerId: string;
  amountCents: number;
  scoutPayoutCents: number;
  missionChangeOrderId?: string;
  missionReviewId?: string;
};

export type SavedPaymentAttempt = {
  state: "paid" | "processing" | "customer_action_required";
  checkoutUrl?: string;
};

export async function ensureAddonPayment(input: AddonPaymentInput) {
  validateAddonInput(input);
  const db = getDb();
  const [scope] = await db.select({ mission: missions })
    .from(missions)
    .where(and(eq(missions.id, input.missionId), eq(missions.customerId, input.customerId)))
    .limit(1);
  if (!scope) throw new Error("Mission payment scope not found.");

  const [booking] = scope.mission.bundleId
    ? await db.select().from(payments).where(and(
      eq(payments.bundleId, scope.mission.bundleId),
      eq(payments.kind, "booking"),
    )).limit(1)
    : await db.select().from(payments).where(and(
      eq(payments.missionId, scope.mission.id),
      eq(payments.kind, "booking"),
    )).limit(1);
  if (!booking || booking.status !== "paid" || !booking.stripePaymentIntentId) {
    throw new Error("The original booking payment is not available for an additional charge.");
  }

  const livemode = getStripeLivemode();
  if (
    booking.customerId !== scope.mission.customerId
    || !booking.stripeCustomerId
    || booking.livemode !== livemode
  ) {
    throw new Error("The booking payment belongs to a different Stripe customer or mode.");
  }
  await validateCanonicalAddonScope(input, scope.mission);

  const idempotencyKey = addonIdempotencyKey(input);
  await db.insert(payments).values({
    missionId: scope.mission.id,
    bundleId: null,
    customerId: scope.mission.customerId,
    missionChangeOrderId: input.kind === "change_order" ? input.missionChangeOrderId! : null,
    missionReviewId: input.kind === "tip" ? input.missionReviewId! : null,
    kind: input.kind,
    currency: "usd",
    stripeCustomerId: booking.stripeCustomerId,
    livemode,
    stripeTransferGroup: booking.stripeTransferGroup,
    idempotencyKey,
    amountCents: input.amountCents,
    scoutPayoutCents: input.scoutPayoutCents,
    platformFeeCents: input.amountCents - input.scoutPayoutCents,
    status: "pending",
  }).onConflictDoNothing();

  const [payment] = await db.select().from(payments).where(
    input.kind === "meet_adjustment"
      ? and(eq(payments.missionId, input.missionId), eq(payments.kind, "meet_adjustment"))
      : input.kind === "change_order"
        ? eq(payments.missionChangeOrderId, input.missionChangeOrderId!)
        : eq(payments.missionReviewId, input.missionReviewId!),
  ).limit(1);
  if (!payment) throw new Error("The additional payment ledger could not be created.");
  if (
    payment.kind !== input.kind
    || payment.missionId !== scope.mission.id
    || payment.bundleId !== null
    || payment.customerId !== scope.mission.customerId
    || payment.missionChangeOrderId !== (input.kind === "change_order" ? input.missionChangeOrderId! : null)
    || payment.missionReviewId !== (input.kind === "tip" ? input.missionReviewId! : null)
    || payment.currency !== "usd"
    || payment.stripeCustomerId !== booking.stripeCustomerId
    || payment.livemode !== livemode
    || payment.stripeTransferGroup !== booking.stripeTransferGroup
    || payment.amountCents !== input.amountCents
    || payment.scoutPayoutCents !== input.scoutPayoutCents
    || payment.platformFeeCents !== input.amountCents - input.scoutPayoutCents
    || payment.idempotencyKey !== idempotencyKey
  ) {
    throw new Error("The existing additional payment does not match the authorized amount.");
  }
  return payment;
}

export async function attemptSavedPayment(paymentId: string): Promise<SavedPaymentAttempt> {
  const db = getDb();
  const [row] = await db.select({ payment: payments, mission: missions })
    .from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row) throw new Error("Additional payment not found.");
  if (row.payment.kind === "booking" || row.payment.kind === "manual") throw new Error("This payment cannot use the saved-card flow.");
  if (!row.payment.stripeCustomerId || row.payment.livemode !== getStripeLivemode()) {
    throw new Error("The additional payment belongs to a different Stripe customer or mode.");
  }
  if (row.payment.status === "paid") {
    await applyPaidAddonPayment(row.payment.id);
    return { state: "paid" };
  }
  if (["refunded", "partially_refunded", "disputed", "authorized"].includes(row.payment.status)) {
    throw new Error("This additional payment cannot be retried.");
  }

  const stripe = getStripe();
  if (row.payment.stripeCheckoutSessionId) return hostedFallback(row.payment.id, row.payment.customerId);
  if (row.payment.stripePaymentIntentId) {
    const currentIntent = await stripe.paymentIntents.retrieve(row.payment.stripePaymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });
    if (currentIntent.status === "succeeded") {
      await recordSuccessfulPaymentIntent(currentIntent);
      return { state: "paid" };
    }
    await recordPaymentIntentState(currentIntent);
    if (currentIntent.status === "processing") return { state: "processing" };
    return hostedFallback(row.payment.id, row.payment.customerId);
  }
  const staleCreate = new Date(Date.now() - OFF_SESSION_CREATE_STALE_MS);
  const canReplayCreate = row.payment.status === "processing"
    && !row.payment.stripePaymentIntentId
    && !row.payment.stripeCheckoutSessionId
    && (
      row.payment.failureCode === OFF_SESSION_OUTCOME_UNKNOWN_CODE
      || (row.payment.failureCode === OFF_SESSION_CREATING_CODE && row.payment.updatedAt < staleCreate)
    );
  if (row.payment.status === "processing" && !canReplayCreate) return { state: "processing" };
  if (["requires_action", "failed", "canceled"].includes(row.payment.status)) {
    return hostedFallback(row.payment.id, row.payment.customerId);
  }

  const [booking] = row.mission.bundleId
    ? await db.select().from(payments).where(and(eq(payments.bundleId, row.mission.bundleId), eq(payments.kind, "booking"))).limit(1)
    : await db.select().from(payments).where(and(eq(payments.missionId, row.mission.id), eq(payments.kind, "booking"))).limit(1);
  if (!booking?.stripePaymentIntentId || booking.status !== "paid") throw new Error("The paid booking card could not be found.");
  const bookingIntent = await stripe.paymentIntents.retrieve(booking.stripePaymentIntentId);
  const paymentMethodId = stripeObjectId(bookingIntent.payment_method);
  if (
    bookingIntent.status !== "succeeded"
    || bookingIntent.livemode !== row.payment.livemode
    || bookingIntent.currency !== row.payment.currency
    || bookingIntent.transfer_group !== row.payment.stripeTransferGroup
    || !paymentMethodId
    || stripeObjectId(bookingIntent.customer) !== row.payment.stripeCustomerId
  ) {
    if (canReplayCreate) return { state: "processing" };
    return hostedFallback(row.payment.id, row.payment.customerId);
  }

  const now = new Date();
  const [claimed] = await db.update(payments).set({
    status: "processing",
    failureCode: OFF_SESSION_CREATING_CODE,
    failureMessage: null,
    failedAt: null,
    updatedAt: now,
  }).where(and(
    eq(payments.id, row.payment.id),
    isNull(payments.stripeCheckoutSessionId),
    isNull(payments.stripePaymentIntentId),
    or(
      eq(payments.status, "pending"),
      and(
        eq(payments.status, "processing"),
        eq(payments.failureCode, OFF_SESSION_OUTCOME_UNKNOWN_CODE),
      ),
      and(
        eq(payments.status, "processing"),
        eq(payments.failureCode, OFF_SESSION_CREATING_CODE),
        lt(payments.updatedAt, staleCreate),
      ),
    ),
  )).returning({ id: payments.id });
  if (!claimed) {
    const [current] = await db.select().from(payments).where(eq(payments.id, row.payment.id)).limit(1);
    if (current?.status === "paid") {
      await applyPaidAddonPayment(current.id);
      return { state: "paid" };
    }
    if (current?.stripeCheckoutSessionId) return hostedFallback(current.id, current.customerId);
    return { state: "processing" };
  }

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: row.payment.amountCents,
      currency: row.payment.currency,
      customer: row.payment.stripeCustomerId,
      payment_method: paymentMethodId,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      transfer_group: row.payment.stripeTransferGroup,
      description: addonDescription(row.payment.kind),
      metadata: addonMetadata(row.payment),
      expand: ["latest_charge.balance_transaction"],
    }, { idempotencyKey: offSessionCreateIdempotencyKey(row.payment.id) });
  } catch (error) {
    const failedIntent = stripeErrorPaymentIntent(error);
    if (failedIntent) {
      const reconciled = await reconcileAttemptIntent(failedIntent);
      return reconciled ?? hostedFallback(row.payment.id, row.payment.customerId);
    }

    if (offSessionCreateErrorDisposition(error) === "outcome_unknown") {
      await db.update(payments).set({
        status: "processing",
        failureCode: OFF_SESSION_OUTCOME_UNKNOWN_CODE,
        failureMessage: "Stripe did not confirm whether the saved-card request completed. The same request will be reconciled before another payment method is offered.",
        failedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(payments.id, row.payment.id),
        eq(payments.status, "processing"),
        eq(payments.failureCode, OFF_SESSION_CREATING_CODE),
        isNull(payments.stripeCheckoutSessionId),
        isNull(payments.stripePaymentIntentId),
      ));
      const [current] = await db.select().from(payments).where(eq(payments.id, row.payment.id)).limit(1);
      if (current?.status === "paid") {
        await applyPaidAddonPayment(current.id);
        return { state: "paid" };
      }
      return { state: "processing" };
    }

    const [markedTerminal] = await db.update(payments).set({
      status: "failed",
      failureCode: OFF_SESSION_TERMINAL_CODE,
      failureMessage: error instanceof Error ? error.message.slice(0, 1000) : "The saved-card request failed.",
      failedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(payments.id, row.payment.id),
      eq(payments.status, "processing"),
      eq(payments.failureCode, OFF_SESSION_CREATING_CODE),
      isNull(payments.stripeCheckoutSessionId),
      isNull(payments.stripePaymentIntentId),
    )).returning({ id: payments.id });
    if (!markedTerminal) {
      const [current] = await db.select().from(payments).where(eq(payments.id, row.payment.id)).limit(1);
      if (current?.status === "paid") {
        await applyPaidAddonPayment(current.id);
        return { state: "paid" };
      }
      return { state: "processing" };
    }
    return hostedFallback(row.payment.id, row.payment.customerId);
  }

  const reconciled = await reconcileAttemptIntent(intent);
  return reconciled ?? hostedFallback(row.payment.id, row.payment.customerId);
}

export async function reconcileAmbiguousOffSessionPayments(limit = 25) {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const staleCreate = new Date(Date.now() - OFF_SESSION_CREATE_STALE_MS);
  const rows = await getDb().select({ id: payments.id }).from(payments).where(and(
    eq(payments.status, "processing"),
    isNull(payments.stripePaymentIntentId),
    isNull(payments.stripeCheckoutSessionId),
    or(
      eq(payments.failureCode, OFF_SESSION_OUTCOME_UNKNOWN_CODE),
      and(
        eq(payments.failureCode, OFF_SESSION_CREATING_CODE),
        lt(payments.updatedAt, staleCreate),
      ),
    ),
  )).orderBy(asc(payments.updatedAt)).limit(boundedLimit);
  let paid = 0;
  let processing = 0;
  let customerActionRequired = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const result = await attemptSavedPayment(row.id);
      if (result.state === "paid") paid += 1;
      else if (result.state === "processing") processing += 1;
      else customerActionRequired += 1;
    } catch (error) {
      errors += 1;
      console.error("Ambiguous off-session payment reconciliation failed", {
        paymentId: row.id,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  return { found: rows.length, paid, processing, customerActionRequired, errors };
}

async function reconcileAttemptIntent(intent: Stripe.PaymentIntent): Promise<SavedPaymentAttempt | null> {
  if (intent.status === "succeeded") {
    await recordSuccessfulPaymentIntent(intent);
    return { state: "paid" };
  }
  await recordPaymentIntentState(intent);
  if (intent.status === "processing") return { state: "processing" };
  return null;
}

async function hostedFallback(paymentId: string, customerId: string): Promise<SavedPaymentAttempt> {
  const checkoutUrl = await createHostedCheckoutForPayment(paymentId, customerId);
  return checkoutUrl ? { state: "customer_action_required", checkoutUrl } : { state: "paid" };
}

function validateAddonInput(input: AddonPaymentInput) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Additional payment amount must be positive.");
  if (!Number.isSafeInteger(input.scoutPayoutCents) || input.scoutPayoutCents < 0 || input.scoutPayoutCents > input.amountCents) {
    throw new Error("Additional Scout payout is invalid.");
  }
  if (input.kind === "change_order" && !input.missionChangeOrderId) throw new Error("Change-order payment scope is missing.");
  if (input.kind === "tip" && !input.missionReviewId) throw new Error("Tip payment scope is missing.");
  if (input.kind !== "change_order" && input.missionChangeOrderId) throw new Error("Unexpected change-order payment scope.");
  if (input.kind !== "tip" && input.missionReviewId) throw new Error("Unexpected tip payment scope.");
}

async function validateCanonicalAddonScope(input: AddonPaymentInput, mission: typeof missions.$inferSelect) {
  const db = getDb();
  if (input.kind === "change_order") {
    const [order] = await db.select().from(missionChangeOrders).where(and(
      eq(missionChangeOrders.id, input.missionChangeOrderId!),
      eq(missionChangeOrders.missionId, mission.id),
    )).limit(1);
    if (
      !order
      || order.status !== "pending"
      || !order.approvedByUserId
      || order.customerDeltaCents !== input.amountCents
      || order.scoutDeltaCents !== input.scoutPayoutCents
      || order.platformDeltaCents !== input.amountCents - input.scoutPayoutCents
    ) throw new Error("The additional-task payment does not match the accepted request.");
    return;
  }
  if (input.kind === "tip") {
    const [review] = await db.select().from(missionReviews).where(and(
      eq(missionReviews.id, input.missionReviewId!),
      eq(missionReviews.missionId, mission.id),
      eq(missionReviews.customerId, mission.customerId),
    )).limit(1);
    if (!review || review.tipCents !== input.amountCents || input.scoutPayoutCents !== input.amountCents) {
      throw new Error("The tip payment does not match the completed mission review.");
    }
    return;
  }
  if (mission.type !== "meet" || mission.status !== "onsite" || !mission.chargedMinutes || !mission.billableEndedAt) {
    throw new Error("The appointment billing snapshot is not finalized.");
  }
  const [changes] = await db.select({
    customerCents: sum(missionChangeOrders.customerDeltaCents),
    scoutCents: sum(missionChangeOrders.scoutDeltaCents),
  }).from(missionChangeOrders).where(and(
    eq(missionChangeOrders.missionId, mission.id),
    eq(missionChangeOrders.status, "approved"),
  ));
  const finalPrice = meetPriceForMinutes(mission.chargedMinutes);
  const reportCustomer = mission.enhancedReportRequested ? ENHANCED_REPORT_CUSTOMER_CENTS : 0;
  const reportScout = mission.enhancedReportRequested ? ENHANCED_REPORT_SCOUT_CENTS : 0;
  const expectedCustomer = finalPrice.customer + reportCustomer + Number(changes?.customerCents ?? 0) - mission.bundleDiscountCents - mission.customerPriceCents;
  const expectedScout = finalPrice.scout + reportScout + Number(changes?.scoutCents ?? 0) - mission.scoutPayoutCents;
  if (input.amountCents !== expectedCustomer || input.scoutPayoutCents !== expectedScout) {
    throw new Error("The appointment adjustment does not match the frozen verified time.");
  }
}

function addonIdempotencyKey(input: AddonPaymentInput) {
  if (input.kind === "meet_adjustment") return `meet_adjustment:${input.missionId}:v1`;
  if (input.kind === "change_order") return `change_order:${input.missionChangeOrderId}:v1`;
  return `tip:${input.missionReviewId}:v1`;
}

function addonMetadata(payment: typeof payments.$inferSelect): Stripe.MetadataParam {
  return {
    sendascout_payment_id: payment.id,
    sendascout_mission_id: payment.missionId,
    sendascout_bundle_id: "",
    sendascout_customer_id: payment.customerId,
    sendascout_payment_kind: payment.kind,
  };
}

function addonDescription(kind: string) {
  if (kind === "meet_adjustment") return "Verified appointment time";
  if (kind === "change_order") return "Additional mission task";
  return "Scout tip";
}

function offSessionCreateIdempotencyKey(paymentId: string) {
  return `payment-intent:${paymentId}:off-session:v1`;
}

function offSessionCreateErrorDisposition(error: unknown): "outcome_unknown" | "terminal" {
  if (typeof error !== "object" || error === null) return "outcome_unknown";
  const candidate = error as { type?: unknown; rawType?: unknown; statusCode?: unknown };
  const type = typeof candidate.type === "string" ? candidate.type : null;
  const rawType = typeof candidate.rawType === "string" ? candidate.rawType : null;
  const statusCode = typeof candidate.statusCode === "number" ? candidate.statusCode : null;
  if (
    AMBIGUOUS_STRIPE_CREATE_ERROR_TYPES.has(type ?? "")
    || statusCode === 429
    || (statusCode !== null && statusCode >= 500)
  ) return "outcome_unknown";
  if (type === "StripeInvalidRequestError" || rawType === "invalid_request_error") return "terminal";
  return "outcome_unknown";
}

function stripeErrorPaymentIntent(error: unknown) {
  if (typeof error !== "object" || error === null || !("payment_intent" in error)) return null;
  const intent = (error as { payment_intent?: unknown }).payment_intent;
  return typeof intent === "object" && intent !== null && "id" in intent
    ? intent as Stripe.PaymentIntent
    : null;
}
