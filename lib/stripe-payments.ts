import "server-only";

import { and, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db";
import {
  missionBundles,
  missionChangeOrders,
  missionReviews,
  missionUpdates,
  missions,
  payments,
  paymentDisputes,
  paymentRefunds,
  users,
} from "@/db/schema";
import { alertEligibleScouts, notifyUser } from "@/lib/notifications";
import { stripeDisputeIsClosed } from "@/lib/stripe-dispute-core";
import { reconcileStripeDisputeMissionLifecycle } from "@/lib/stripe-dispute-lifecycle";
import {
  LATE_PAYMENT_REFUND_CODE,
  refundLatePaymentBestEffort,
} from "@/lib/stripe-late-payment-refunds";
import { syncRefundedPayment } from "@/lib/stripe-refunds";
import { settleMissionBestEffort } from "@/lib/stripe-settlement";
import { getAppUrl, getStripe, getStripeLivemode, stripeObjectId } from "@/lib/stripe";

type AppUser = typeof users.$inferSelect;
type PaymentRecord = typeof payments.$inferSelect;

const payableStatuses: PaymentRecord["status"][] = [
  "pending",
  "requires_action",
  "failed",
  "canceled",
];

export async function ensureStripeCustomer(user: AppUser) {
  const stripe = getStripe();
  const livemode = getStripeLivemode();
  if (user.stripeCustomerId) {
    if (user.stripeCustomerLivemode !== null && user.stripeCustomerLivemode !== livemode) {
      throw new Error("This environment is connected to a different Stripe mode. Use an isolated test or live database before accepting payments.");
    }
    if (user.stripeCustomerLivemode === null) {
      const customer = await stripe.customers.retrieve(user.stripeCustomerId);
      if (customer.deleted) throw new Error("The existing Stripe customer is no longer available.");
      if (customer.livemode !== livemode) throw new Error("The saved Stripe customer belongs to a different Stripe mode.");
      await getDb().update(users).set({ stripeCustomerLivemode: livemode, updatedAt: new Date() }).where(eq(users.id, user.id));
    }
    return user.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
    phone: user.phone ?? undefined,
    metadata: { sendascout_user_id: user.id },
  }, { idempotencyKey: `customer:${user.id}:v1` });

  const [saved] = await getDb().update(users).set({
    stripeCustomerId: customer.id,
    stripeCustomerLivemode: customer.livemode,
    updatedAt: new Date(),
  }).where(and(eq(users.id, user.id), isNull(users.stripeCustomerId))).returning({
    stripeCustomerId: users.stripeCustomerId,
    stripeCustomerLivemode: users.stripeCustomerLivemode,
  });
  if (saved?.stripeCustomerId) return saved.stripeCustomerId;

  const [current] = await getDb().select({ stripeCustomerId: users.stripeCustomerId, stripeCustomerLivemode: users.stripeCustomerLivemode })
    .from(users).where(eq(users.id, user.id)).limit(1);
  if (!current?.stripeCustomerId) throw new Error("Your Stripe customer record could not be saved. Please try again.");
  if (current.stripeCustomerLivemode !== null && current.stripeCustomerLivemode !== livemode) throw new Error("The saved Stripe customer belongs to a different Stripe mode.");
  return current.stripeCustomerId;
}

export async function createHostedCheckoutForPayment(paymentId: string, customerId: string) {
  const db = getDb();
  const [row] = await db.select({ payment: payments, mission: missions })
    .from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .where(and(eq(payments.id, paymentId), eq(payments.customerId, customerId)))
    .limit(1);
  if (!row) throw new Error("Payment request not found.");
  if (!row.payment.stripeCustomerId) throw new Error("This legacy payment does not have a Stripe customer and cannot be retried automatically.");
  if (row.payment.livemode === null) throw new Error("This legacy payment must be reconciled before it can be retried.");
  if (row.payment.livemode !== null && row.payment.livemode !== getStripeLivemode()) throw new Error("This payment belongs to a different Stripe mode.");
  if (row.payment.status === "paid") return null;
  if (!payableStatuses.includes(row.payment.status)) throw new Error("This payment cannot be retried.");
  if (row.payment.amountCents <= 0) throw new Error("The payment amount must be greater than zero.");

  const stripe = getStripe();
  let priorSessionId = row.payment.stripeCheckoutSessionId;
  if (priorSessionId) {
    const prior = await stripe.checkout.sessions.retrieve(priorSessionId);
    validateCheckoutSession(prior, row.payment);
    if (prior.status === "open" && prior.url) return prior.url;
    if (prior.payment_status === "paid") {
      if (stripeObjectId(prior.payment_intent)) {
        const intent = await stripe.paymentIntents.retrieve(stripeObjectId(prior.payment_intent)!, { expand: ["latest_charge.balance_transaction"] });
        await recordSuccessfulPaymentIntent(intent, prior.id);
      }
      return null;
    }
  }

  const appUrl = getAppUrl();
  const productName = paymentProductName(row.payment.kind, row.mission.title);
  const claimTime = new Date();
  const staleClaim = new Date(claimTime.getTime() - 5 * 60 * 1000);
  const [claimed] = await db.update(payments).set({
    status: "processing",
    failureCode: "checkout_creating",
    failureMessage: null,
    updatedAt: claimTime,
  }).where(and(
    eq(payments.id, row.payment.id),
    eq(payments.customerId, customerId),
    sql`${payments.stripeCheckoutSessionId} IS NOT DISTINCT FROM ${priorSessionId}`,
    or(
      inArray(payments.status, payableStatuses),
      and(
        eq(payments.status, "processing"),
        eq(payments.failureCode, "checkout_creating"),
        isNull(payments.stripePaymentIntentId),
        lt(payments.updatedAt, staleClaim),
      ),
    ),
  )).returning({ id: payments.id });
  if (!claimed) {
    const [current] = await db.select().from(payments).where(and(eq(payments.id, row.payment.id), eq(payments.customerId, customerId))).limit(1);
    if (current?.status === "paid") return null;
    if (current?.stripeCheckoutSessionId && current.stripeCheckoutSessionId !== priorSessionId) {
      const session = await stripe.checkout.sessions.retrieve(current.stripeCheckoutSessionId);
      validateCheckoutSession(session, current);
      if (session.status === "open" && session.url) return session.url;
      if (session.payment_status === "paid") {
        await recordCheckoutSessionPaid(session);
        return null;
      }
    }
    throw new Error("This payment is already being processed. Refresh its status before trying again.");
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: row.payment.stripeCustomerId,
      client_reference_id: row.mission.id,
      payment_method_types: ["card"],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: row.payment.amountCents,
          product_data: {
            name: productName,
            description: row.payment.kind === "booking"
              ? "Payment is collected before the mission is released to eligible Scouts."
              : "Additional mission payment",
            metadata: {
              sendascout_mission_id: row.mission.id,
              sendascout_payment_kind: row.payment.kind,
            },
          },
        },
      }],
      payment_intent_data: {
        setup_future_usage: "off_session",
        transfer_group: row.payment.stripeTransferGroup,
        metadata: paymentMetadata(row.payment),
      },
      metadata: paymentMetadata(row.payment),
      success_url: `${appUrl}/dashboard/customer/payments?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/dashboard/customer/payments?checkout=cancelled&mission_id=${row.mission.id}`,
    }, {
      idempotencyKey: `checkout:${row.payment.id}:${priorSessionId ?? "initial"}`,
    });
  } catch (error) {
    await db.update(payments).set({
      status: "failed",
      failureCode: "checkout_request_failed",
      failureMessage: error instanceof Error ? error.message.slice(0, 1000) : "Stripe Checkout could not be created.",
      failedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(payments.id, row.payment.id),
      eq(payments.status, "processing"),
      eq(payments.failureCode, "checkout_creating"),
    ));
    throw error;
  }
  validateCheckoutSession(session, row.payment);
  if (!session.url) {
    await db.update(payments).set({
      status: "failed",
      failureCode: "checkout_url_missing",
      failureMessage: "Stripe did not return a secure checkout URL.",
      failedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(payments.id, row.payment.id),
      eq(payments.status, "processing"),
      eq(payments.failureCode, "checkout_creating"),
    ));
    throw new Error("Stripe did not return a secure checkout URL.");
  }

  const [savedSession] = await db.update(payments).set({
    stripeCheckoutSessionId: session.id,
    status: "pending",
    failureCode: null,
    failureMessage: null,
    cancelledAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(payments.id, row.payment.id),
    eq(payments.customerId, customerId),
    eq(payments.status, "processing"),
    eq(payments.failureCode, "checkout_creating"),
  )).returning({ id: payments.id });
  if (!savedSession) throw new Error("Stripe Checkout was created but could not be linked to the payment ledger.");
  return session.url;
}

export async function recordCheckoutSessionPaid(session: Stripe.Checkout.Session) {
  const paymentIntentId = stripeObjectId(session.payment_intent);
  if (!paymentIntentId) throw new Error(`Paid Checkout Session ${session.id} does not have a PaymentIntent.`);
  const intent = await getStripe().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  return recordSuccessfulPaymentIntent(intent, session.id);
}

export async function recordSuccessfulPaymentIntent(intent: Stripe.PaymentIntent, checkoutSessionId?: string | null) {
  if (intent.status !== "succeeded") throw new Error(`PaymentIntent ${intent.id} is not successful.`);
  const paymentId = intent.metadata.sendascout_payment_id;
  const db = getDb();
  const [row] = paymentId
    ? await db.select({ payment: payments, mission: missions }).from(payments)
      .innerJoin(missions, eq(missions.id, payments.missionId))
      .where(eq(payments.id, paymentId)).limit(1)
    : await db.select({ payment: payments, mission: missions }).from(payments)
      .innerJoin(missions, eq(missions.id, payments.missionId))
      .where(eq(payments.stripePaymentIntentId, intent.id)).limit(1);
  if (!row) throw new Error(`PaymentIntent ${intent.id} is not linked to a Send a Scout payment.`);

  const stripeCustomerId = stripeObjectId(intent.customer);
  const stripeChargeId = stripeObjectId(intent.latest_charge);
  const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const balanceTransaction = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  if (intent.metadata.sendascout_mission_id !== row.payment.missionId) throw new Error("Stripe mission metadata does not match the payment ledger.");
  if (intent.metadata.sendascout_payment_kind !== row.payment.kind) throw new Error("Stripe payment-kind metadata does not match the payment ledger.");
  if (intent.metadata.sendascout_customer_id !== row.payment.customerId) throw new Error("Stripe customer metadata does not match the payment ledger.");
  if (intent.amount_received !== row.payment.amountCents || intent.currency !== row.payment.currency) throw new Error("Stripe amount or currency does not match the payment ledger.");
  if (stripeCustomerId !== row.payment.stripeCustomerId) throw new Error("Stripe customer does not match the payment ledger.");
  if (row.payment.livemode !== null && intent.livemode !== row.payment.livemode) throw new Error("Stripe mode does not match the payment ledger.");
  if (intent.transfer_group !== row.payment.stripeTransferGroup) throw new Error("Stripe transfer group does not match the payment ledger.");
  if (!stripeChargeId) throw new Error(`PaymentIntent ${intent.id} does not have a source Charge.`);

  const now = new Date();
  const preferredUntil = row.mission.preferredScoutId
    ? new Date(now.getTime() + 60 * 60 * 1000)
    : null;
  const lifecycleBundleId = row.payment.bundleId ?? row.mission.bundleId;
  const result = await db.execute(sql`
    WITH locked_missions AS MATERIALIZED (
      SELECT locked_mission.id, locked_mission.bundle_id, locked_mission.bundle_sequence,
        locked_mission.status, locked_mission.archived_at
      FROM missions AS locked_mission
      WHERE locked_mission.id = ${row.mission.id}
        OR (
          ${Boolean(lifecycleBundleId)}
          AND locked_mission.bundle_id = ${lifecycleBundleId}
        )
      ORDER BY locked_mission.id
      FOR UPDATE OF locked_mission
    ), locked_bundle AS MATERIALIZED (
      SELECT locked_parent.id, locked_parent.status, locked_parent.active_sequence
      FROM mission_bundles AS locked_parent
      INNER JOIN locked_missions AS bundle_anchor
        ON bundle_anchor.id = ${row.mission.id}
        AND bundle_anchor.bundle_id = locked_parent.id
      WHERE locked_parent.id = ${lifecycleBundleId}
      FOR UPDATE OF locked_parent
    ), payment_eligibility AS MATERIALIZED (
      SELECT candidate.id,
        CASE
          WHEN candidate.kind = 'booking' THEN
            root.status = 'draft'
            AND root.archived_at IS NULL
            AND (
              candidate.bundle_id IS NULL
              OR (
                EXISTS (
                  SELECT 1 FROM locked_bundle AS eligible_bundle
                  WHERE eligible_bundle.id = candidate.bundle_id
                    AND eligible_bundle.status = 'draft'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM locked_missions AS ineligible_leg
                  WHERE ineligible_leg.bundle_id = candidate.bundle_id
                    AND (ineligible_leg.archived_at IS NOT NULL OR ineligible_leg.status <> 'draft')
                )
              )
            )
          WHEN candidate.kind = 'meet_adjustment' THEN
            root.status = 'onsite' AND root.archived_at IS NULL
          WHEN candidate.kind = 'change_order' THEN
            root.archived_at IS NULL
            AND root.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff')
            AND EXISTS (
              SELECT 1 FROM mission_change_orders AS eligible_order
              WHERE eligible_order.id = candidate.mission_change_order_id
                AND eligible_order.mission_id = root.id
                AND eligible_order.status = 'pending'
                AND eligible_order.approved_by_user_id IS NOT NULL
            )
            AND (
              root.bundle_id IS NULL
              OR EXISTS (
                SELECT 1 FROM locked_bundle AS active_bundle
                WHERE active_bundle.id = root.bundle_id
                  AND active_bundle.active_sequence = root.bundle_sequence
                  AND active_bundle.status IN ('claimed', 'in_progress')
              )
            )
          WHEN candidate.kind = 'tip' THEN
            root.status = 'completed'
            AND root.archived_at IS NULL
            AND (
              root.bundle_id IS NULL
              OR EXISTS (
                SELECT 1 FROM locked_bundle AS completed_bundle
                WHERE completed_bundle.id = root.bundle_id
                  AND completed_bundle.status = 'completed'
              )
            )
            AND EXISTS (
              SELECT 1 FROM mission_reviews AS eligible_review
              WHERE eligible_review.id = candidate.mission_review_id
                AND eligible_review.mission_id = root.id
                AND eligible_review.customer_id = candidate.customer_id
                AND eligible_review.tip_cents = candidate.amount_cents
                AND eligible_review.tip_status NOT IN ('cancelled', 'partially_refunded', 'refunded', 'disputed')
            )
          ELSE TRUE
        END AS eligible
      FROM payments AS candidate
      INNER JOIN locked_missions AS root ON root.id = candidate.mission_id
      WHERE candidate.id = ${row.payment.id}
    ), paid_payment AS (
      UPDATE payments AS payment
      SET status = 'paid',
          stripe_checkout_session_id = COALESCE(${checkoutSessionId ?? null}, payment.stripe_checkout_session_id),
          stripe_payment_intent_id = ${intent.id},
          stripe_charge_id = ${stripeChargeId},
          livemode = ${intent.livemode},
          stripe_balance_transaction_id = ${balanceTransaction?.id ?? null},
          stripe_fee_cents = ${balanceTransaction?.fee ?? null},
          stripe_net_cents = ${balanceTransaction?.net ?? null},
          failure_code = CASE
            WHEN payment.failure_code = ${LATE_PAYMENT_REFUND_CODE} THEN ${LATE_PAYMENT_REFUND_CODE}
            WHEN payment.paid_at IS NULL
              AND NOT COALESCE((SELECT eligible FROM payment_eligibility), FALSE)
              THEN ${LATE_PAYMENT_REFUND_CODE}
            ELSE NULL
          END,
          failure_message = CASE
            WHEN payment.failure_code = ${LATE_PAYMENT_REFUND_CODE}
              OR (
                payment.paid_at IS NULL
                AND NOT COALESCE((SELECT eligible FROM payment_eligibility), FALSE)
              )
              THEN 'Payment cleared after its mission or add-on was no longer eligible. An exact-charge refund is required.'
            ELSE NULL
          END,
          paid_at = COALESCE(payment.paid_at, ${now}),
          failed_at = NULL,
          cancelled_at = NULL,
          updated_at = ${now}
      WHERE payment.id = ${row.payment.id}
        AND payment.customer_id = ${row.payment.customerId}
        AND payment.amount_cents = ${row.payment.amountCents}
        AND payment.currency = ${row.payment.currency}
        AND payment.stripe_customer_id = ${row.payment.stripeCustomerId}
        AND payment.stripe_transfer_group = ${row.payment.stripeTransferGroup}
        AND (
          payment.paid_at IS NULL
          OR payment.stripe_payment_intent_id IS NULL
          OR payment.stripe_payment_intent_id = ${intent.id}
        )
        AND (
          payment.paid_at IS NULL
          OR payment.stripe_charge_id IS NULL
          OR payment.stripe_charge_id = ${stripeChargeId}
        )
        AND (
          payment.paid_at IS NULL
          OR
          ${checkoutSessionId === null || checkoutSessionId === undefined}
          OR payment.stripe_checkout_session_id IS NULL
          OR payment.stripe_checkout_session_id = ${checkoutSessionId ?? ""}
        )
        AND payment.status NOT IN ('partially_refunded', 'refunded', 'disputed')
        AND NOT EXISTS (
          SELECT 1
          FROM payment_disputes AS blocking_dispute
          WHERE blocking_dispute.payment_id = payment.id
            AND blocking_dispute.status NOT IN ('won', 'prevented', 'warning_closed')
        )
      RETURNING payment.id, payment.failure_code
    ), published_root AS (
      UPDATE missions AS root
      SET status = 'open',
          payment_status = 'paid',
          stripe_payment_intent_id = ${intent.id},
          preferred_scout_exclusive_until = ${preferredUntil},
          preferred_scout_broadcast_at = NULL,
          updated_at = ${now}
      WHERE root.id = ${row.mission.id}
        AND root.status = 'draft'
        AND root.archived_at IS NULL
        AND ${row.payment.kind} = 'booking'
        AND EXISTS (SELECT 1 FROM paid_payment)
        AND COALESCE((SELECT eligible FROM payment_eligibility), FALSE)
      RETURNING root.id, root.bundle_id
    ), marked_children AS (
      UPDATE missions AS child
      SET payment_status = 'paid',
          stripe_payment_intent_id = ${intent.id},
          updated_at = ${now}
      WHERE child.bundle_id = ${row.payment.bundleId}
        AND child.id <> ${row.mission.id}
        AND child.archived_at IS NULL
        AND ${row.payment.kind} = 'booking'
        AND EXISTS (SELECT 1 FROM published_root)
      RETURNING child.id
    ), marked_bundle AS (
      UPDATE mission_bundles AS bundle
      SET status = 'open',
          payment_status = 'paid',
          stripe_payment_intent_id = ${intent.id},
          updated_at = ${now}
      WHERE bundle.id = ${row.payment.bundleId}
        AND bundle.status = 'draft'
        AND ${row.payment.kind} = 'booking'
        AND EXISTS (SELECT 1 FROM published_root)
      RETURNING bundle.id
    ), audited AS (
      INSERT INTO mission_updates (mission_id, author_id, status, message)
      SELECT published_root.id, ${row.payment.customerId}, 'open'::mission_status,
        CASE WHEN ${row.mission.preferredScoutId} IS NULL
          THEN 'Payment received. Mission published to eligible Scouts.'
          ELSE 'Payment received. Mission offered to the preferred Scout first.'
        END
      FROM published_root
      RETURNING mission_id
    )
    SELECT
      (SELECT COUNT(*)::integer FROM paid_payment) AS paid_count,
      (SELECT COUNT(*)::integer FROM published_root) AS published_count,
      (SELECT COUNT(*)::integer FROM marked_children) AS child_count,
      (SELECT COUNT(*)::integer FROM marked_bundle) AS bundle_count,
      (SELECT COUNT(*)::integer FROM audited) AS audit_count,
      (SELECT COUNT(*)::integer FROM paid_payment WHERE failure_code = ${LATE_PAYMENT_REFUND_CODE}) AS late_refund_count
  `) as unknown as Array<{ paid_count: number; published_count: number; child_count: number; bundle_count: number; audit_count: number; late_refund_count: number }>;
  if (Number(result[0]?.paid_count ?? 0) !== 1) {
    const [current] = await db.select().from(payments).where(eq(payments.id, row.payment.id)).limit(1);
    const sameProviderIdentity = current?.stripePaymentIntentId === intent.id
      && current.stripeChargeId === stripeChargeId
      && (!checkoutSessionId || !current.stripeCheckoutSessionId || current.stripeCheckoutSessionId === checkoutSessionId);
    if (!sameProviderIdentity) {
      const duplicateKey = `duplicate_payment_intent_${intent.id}`;
      await db.insert(payments).values({
        missionId: row.payment.missionId,
        bundleId: null,
        customerId: row.payment.customerId,
        kind: "duplicate",
        currency: row.payment.currency,
        stripeCustomerId: row.payment.stripeCustomerId,
        livemode: intent.livemode,
        stripePaymentIntentId: intent.id,
        stripeChargeId,
        stripeBalanceTransactionId: balanceTransaction?.id ?? null,
        stripeFeeCents: balanceTransaction?.fee ?? null,
        stripeNetCents: balanceTransaction?.net ?? null,
        stripeTransferGroup: row.payment.stripeTransferGroup,
        idempotencyKey: duplicateKey,
        amountCents: row.payment.amountCents,
        scoutPayoutCents: 0,
        platformFeeCents: row.payment.amountCents,
        status: "paid",
        failureCode: LATE_PAYMENT_REFUND_CODE,
        failureMessage: `A second successful Stripe charge attempted to replace payment ${row.payment.id}. The duplicate charge must be refunded in full.`,
        paidAt: now,
      }).onConflictDoNothing();
      const [duplicate] = await db.select().from(payments).where(eq(payments.idempotencyKey, duplicateKey)).limit(1);
      if (!duplicate
        || duplicate.kind !== "duplicate"
        || duplicate.missionId !== row.payment.missionId
        || duplicate.customerId !== row.payment.customerId
        || duplicate.stripePaymentIntentId !== intent.id
        || duplicate.stripeChargeId !== stripeChargeId
        || duplicate.amountCents !== row.payment.amountCents
        || duplicate.failureCode !== LATE_PAYMENT_REFUND_CODE) {
        throw new Error(`Duplicate successful PaymentIntent ${intent.id} could not be durably isolated for refund.`);
      }
      await refundLatePaymentBestEffort(duplicate.id, "duplicate_successful_payment_intent");
      return { paymentId: duplicate.id, missionId: row.mission.id, published: false, addon: null, duplicateRefundRequired: true };
    }
  }
  const published = Number(result[0]?.published_count ?? 0) === 1;
  if (published) await alertEligibleScouts(row.mission.id);
  if (Number(result[0]?.late_refund_count ?? 0) === 1) {
    await refundLatePaymentBestEffort(row.payment.id, "payment_success");
  }
  const addon = await applyPaidAddonPayment(row.payment.id);
  return { paymentId: row.payment.id, missionId: row.mission.id, published, addon };
}

export async function applyPaidAddonPayment(paymentId: string) {
  const db = getDb();
  const [row] = await db.select({ payment: payments, mission: missions, bundle: missionBundles })
    .from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row || row.payment.status !== "paid" || ["booking", "manual", "duplicate"].includes(row.payment.kind)) return null;
  if (row.payment.failureCode === LATE_PAYMENT_REFUND_CODE) {
    await refundLatePaymentBestEffort(row.payment.id, "paid_addon_already_marked");
    return { kind: row.payment.kind, applied: false, late: true };
  }

  if (row.payment.kind === "tip") {
    if (!row.payment.missionReviewId) {
      return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "tip_scope_missing");
    }
    const [updated] = await db.update(missionReviews).set({ tipStatus: "paid" }).where(and(
      eq(missionReviews.id, row.payment.missionReviewId),
      eq(missionReviews.missionId, row.mission.id),
      eq(missionReviews.customerId, row.payment.customerId),
      eq(missionReviews.tipCents, row.payment.amountCents),
      inArray(missionReviews.tipStatus, ["unpaid", "pending", "requires_action", "processing", "authorized", "failed"]),
    )).returning({ id: missionReviews.id });
    if (!updated) {
      const [review] = await db.select().from(missionReviews).where(eq(missionReviews.id, row.payment.missionReviewId)).limit(1);
      const alreadyApplied = review?.missionId === row.mission.id
        && review.customerId === row.payment.customerId
        && review.tipCents === row.payment.amountCents
        && review.tipStatus === "paid";
      if (!alreadyApplied) {
        return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "tip_no_longer_eligible");
      }
    }
    await settleMissionBestEffort(row.mission.id, "paid_tip");
    return { kind: "tip" as const, applied: Boolean(updated) };
  }

  if (row.payment.kind === "meet_adjustment") {
    if (row.mission.scoutId && row.mission.status === "onsite") {
      const notificationKind = `meet_adjustment_paid:${row.payment.id}`;
      await notifyUser({
        recipientUserId: row.mission.scoutId,
        missionId: row.mission.id,
        kind: notificationKind,
        title: "Appointment payment confirmed",
        body: "The customer confirmed the additional verified appointment time. Resubmit the mission results to finish this part.",
        actionLabel: "Open mission",
        actionUrl: `https://sendascout.com/dashboard/missions/${row.mission.id}`,
      });
    }
    return { kind: "meet_adjustment" as const, applied: false };
  }

  if (!row.payment.missionChangeOrderId) {
    return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "change_order_scope_missing");
  }
  const [order] = await db.select().from(missionChangeOrders).where(and(
    eq(missionChangeOrders.id, row.payment.missionChangeOrderId),
    eq(missionChangeOrders.missionId, row.mission.id),
  )).limit(1);
  if (!order) {
    return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "change_order_missing");
  }
  if (order.status === "approved" || order.status === "fulfilled") return { kind: "change_order" as const, applied: false };
  const active = ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff"].includes(row.mission.status);
  const activeBundle = !row.mission.bundleId || (
    row.bundle?.id === row.mission.bundleId
    && row.bundle.activeSequence === row.mission.bundleSequence
    && ["claimed", "in_progress"].includes(row.bundle.status)
  );
  if (order.status !== "pending" || !order.approvedByUserId || !active || !activeBundle) {
    return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "change_order_no_longer_eligible");
  }

  const expectedBundleCount = row.mission.bundleId ? 1 : 0;
  const applyTime = new Date();
  let applied: Array<{ id: string }>;
  try {
    applied = await db.execute(sql`
    WITH locked_mission AS MATERIALIZED (
      SELECT active_mission.id, active_mission.bundle_id, active_mission.bundle_sequence,
        active_mission.status, active_mission.archived_at
      FROM missions AS active_mission
      WHERE active_mission.id = ${row.mission.id}
      FOR UPDATE OF active_mission
    ), locked_bundle AS MATERIALIZED (
      SELECT active_bundle.id
      FROM mission_bundles AS active_bundle
      INNER JOIN locked_mission
        ON locked_mission.bundle_id = active_bundle.id
      WHERE active_bundle.active_sequence = locked_mission.bundle_sequence
        AND active_bundle.status IN ('claimed', 'in_progress')
      FOR UPDATE OF active_bundle
    ), eligible_order AS MATERIALIZED (
      SELECT requested.id, requested.mission_id, requested.approved_by_user_id,
        requested.customer_delta_cents, requested.scout_delta_cents, requested.platform_delta_cents,
        active_mission.bundle_id, active_mission.bundle_sequence
      FROM mission_change_orders AS requested
      INNER JOIN payments AS paid_payment
        ON paid_payment.mission_change_order_id = requested.id
      INNER JOIN locked_mission AS active_mission
        ON active_mission.id = requested.mission_id
      WHERE requested.id = ${order.id}
        AND requested.status = 'pending'
        AND requested.approved_by_user_id IS NOT NULL
        AND paid_payment.id = ${row.payment.id}
        AND paid_payment.status = 'paid'
        AND active_mission.archived_at IS NULL
        AND active_mission.status IN ('claimed', 'en_route', 'onsite', 'en_route_pickup', 'at_pickup', 'en_route_dropoff', 'at_dropoff')
        AND (
          active_mission.bundle_id IS NULL
          OR EXISTS (SELECT 1 FROM locked_bundle)
        )
      FOR UPDATE OF requested
    ), updated_mission AS (
      UPDATE missions AS active_mission
      SET customer_price_cents = active_mission.customer_price_cents + eligible_order.customer_delta_cents,
          list_customer_price_cents = CASE WHEN active_mission.list_customer_price_cents IS NULL THEN NULL ELSE active_mission.list_customer_price_cents + eligible_order.customer_delta_cents END,
          scout_payout_cents = active_mission.scout_payout_cents + eligible_order.scout_delta_cents,
          platform_fee_cents = active_mission.platform_fee_cents + eligible_order.platform_delta_cents,
          maximum_customer_price_cents = CASE WHEN active_mission.maximum_customer_price_cents IS NULL THEN NULL ELSE active_mission.maximum_customer_price_cents + eligible_order.customer_delta_cents END,
          maximum_scout_payout_cents = CASE WHEN active_mission.maximum_scout_payout_cents IS NULL THEN NULL ELSE active_mission.maximum_scout_payout_cents + eligible_order.scout_delta_cents END,
          updated_at = ${applyTime}
      FROM eligible_order
      WHERE active_mission.id = eligible_order.mission_id
      RETURNING active_mission.id, active_mission.bundle_id, active_mission.bundle_sequence,
        eligible_order.customer_delta_cents, eligible_order.scout_delta_cents, eligible_order.platform_delta_cents
    ), updated_bundle AS (
      UPDATE mission_bundles AS active_bundle
      SET list_customer_price_cents = active_bundle.list_customer_price_cents + updated_mission.customer_delta_cents,
          customer_price_cents = active_bundle.customer_price_cents + updated_mission.customer_delta_cents,
          scout_payout_cents = active_bundle.scout_payout_cents + updated_mission.scout_delta_cents,
          platform_fee_cents = active_bundle.platform_fee_cents + updated_mission.platform_delta_cents,
          updated_at = ${applyTime}
      FROM updated_mission
      WHERE updated_mission.bundle_id IS NOT NULL
        AND active_bundle.id = updated_mission.bundle_id
        AND active_bundle.active_sequence = updated_mission.bundle_sequence
        AND active_bundle.status IN ('claimed', 'in_progress')
      RETURNING active_bundle.id
    ), approved_order AS (
      UPDATE mission_change_orders AS requested
      SET status = 'approved', expires_at = NULL, updated_at = ${applyTime}
      FROM updated_mission
      WHERE requested.id = ${order.id}
        AND requested.status = 'pending'
        AND (
          updated_mission.bundle_id IS NULL
          OR EXISTS (SELECT 1 FROM updated_bundle)
        )
      RETURNING requested.id, requested.mission_id, requested.approved_by_user_id
    ), audited AS (
      INSERT INTO mission_updates (mission_id, author_id, status, message)
      SELECT approved_order.mission_id, approved_order.approved_by_user_id, ${row.mission.status}::mission_status,
        'Both participants approved and paid for the additional task.'
      FROM approved_order
      RETURNING id
    )
    SELECT CASE
      WHEN (SELECT COUNT(*) FROM updated_mission) = 1
        AND (SELECT COUNT(*) FROM updated_bundle) = ${expectedBundleCount}
        AND (SELECT COUNT(*) FROM approved_order) = 1
        AND (SELECT COUNT(*) FROM audited) = 1
      THEN (SELECT id::text FROM approved_order)
      ELSE (1 / ((SELECT COUNT(*)::integer FROM approved_order) - (SELECT COUNT(*)::integer FROM approved_order)))::text
    END AS id
    `) as unknown as Array<{ id: string }>;
  } catch (error) {
    const currentState = await getPaidChangeOrderState(row.payment.id);
    if (currentState === "applied") {
      return { kind: "change_order" as const, applied: false };
    }
    if (currentState === "late") {
      return markPaidAddonForLateRefund(row.payment.id, row.payment.kind, "change_order_apply_race");
    }
    throw error;
  }
  if (!applied[0]?.id) throw new Error("Paid change order could not be authorized atomically.");

  const recipients = new Set([row.mission.customerId, row.mission.scoutId].filter((id): id is string => Boolean(id)));
  for (const recipientUserId of recipients) {
    await notifyUser({
      recipientUserId,
      missionId: row.mission.id,
      kind: "change_order_approved",
      title: "Additional task approved",
      body: `Payment is confirmed. The additional task adds $${(order.customerDeltaCents / 100).toFixed(2)} to the customer total and $${(order.scoutDeltaCents / 100).toFixed(2)} to Scout earnings.`,
      actionLabel: "View mission",
      actionUrl: `https://sendascout.com/dashboard/missions/${row.mission.id}`,
    });
  }
  return { kind: "change_order" as const, applied: true };
}

export async function reconcilePaidAddonApplications(limit = 25) {
  const boundedLimit = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 25));
  const rows = await getDb().execute(sql`
    SELECT paid_addon.id
    FROM payments AS paid_addon
    LEFT JOIN mission_change_orders AS requested
      ON requested.id = paid_addon.mission_change_order_id
    LEFT JOIN mission_reviews AS review
      ON review.id = paid_addon.mission_review_id
    WHERE paid_addon.status = 'paid'
      AND (
        (
          paid_addon.kind = 'change_order'
          AND (
            paid_addon.failure_code = ${LATE_PAYMENT_REFUND_CODE}
            OR requested.id IS NULL
            OR requested.status NOT IN ('approved', 'fulfilled')
          )
        )
        OR (
          paid_addon.kind = 'tip'
          AND (
            paid_addon.failure_code = ${LATE_PAYMENT_REFUND_CODE}
            OR review.id IS NULL
            OR review.tip_status <> 'paid'
          )
        )
      )
    ORDER BY paid_addon.updated_at ASC
    LIMIT ${boundedLimit}
  `) as unknown as Array<{ id: string }>;

  let applied = 0;
  let late = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      const result = await applyPaidAddonPayment(row.id);
      if (result?.late) late += 1;
      else applied += 1;
    } catch (error) {
      errors += 1;
      console.error("Paid add-on could not be reconciled", { paymentId: row.id, error });
    }
  }
  return { found: rows.length, applied, late, errors };
}

async function markPaidAddonForLateRefund(paymentId: string, kind: PaymentRecord["kind"], source: string) {
  const now = new Date();
  await getDb().update(payments).set({
    failureCode: LATE_PAYMENT_REFUND_CODE,
    failureMessage: "Payment cleared after its add-on was no longer eligible. An exact-charge refund is required.",
    updatedAt: now,
  }).where(and(
    eq(payments.id, paymentId),
    inArray(payments.kind, ["meet_adjustment", "change_order", "tip"]),
    inArray(payments.status, ["paid", "partially_refunded", "disputed"]),
  ));
  await refundLatePaymentBestEffort(paymentId, source);
  return { kind, applied: false, late: true as const };
}

async function getPaidChangeOrderState(paymentId: string): Promise<"eligible" | "applied" | "late"> {
  const [row] = await getDb().select({ payment: payments, mission: missions, order: missionChangeOrders, bundle: missionBundles })
    .from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .leftJoin(missionChangeOrders, eq(missionChangeOrders.id, payments.missionChangeOrderId))
    .leftJoin(missionBundles, eq(missionBundles.id, missions.bundleId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!row || row.payment.status !== "paid" || row.payment.failureCode === LATE_PAYMENT_REFUND_CODE) return "late";
  if (row.order?.status === "approved" || row.order?.status === "fulfilled") return "applied";
  const activeMission = row.mission.archivedAt === null
    && ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff"].includes(row.mission.status);
  const activeBundle = !row.mission.bundleId || (
    row.bundle?.id === row.mission.bundleId
    && row.bundle.activeSequence === row.mission.bundleSequence
    && ["claimed", "in_progress"].includes(row.bundle.status)
  );
  return row.order?.missionId === row.mission.id
    && row.order.status === "pending"
    && Boolean(row.order.approvedByUserId)
    && activeMission
    && activeBundle
    ? "eligible"
    : "late";
}

export async function recordPaymentIntentState(intent: Stripe.PaymentIntent) {
  if (intent.status === "succeeded") return recordSuccessfulPaymentIntent(intent);
  const paymentId = intent.metadata.sendascout_payment_id;
  const db = getDb();
  const [payment] = paymentId
    ? await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1)
    : await db.select().from(payments).where(eq(payments.stripePaymentIntentId, intent.id)).limit(1);
  if (!payment || ["paid", "partially_refunded", "refunded", "disputed"].includes(payment.status)) return null;
  const status = paymentIntentLedgerStatus(intent.status);
  const now = new Date();
  const failure = intent.last_payment_error;
  const [updated] = await db.update(payments).set({
    stripePaymentIntentId: intent.id,
    status,
    failureCode: failure?.code ?? null,
    failureMessage: failure?.message ?? null,
    failedAt: status === "failed" ? now : null,
    cancelledAt: status === "canceled" ? now : null,
    updatedAt: now,
  }).where(and(
    eq(payments.id, payment.id),
    notInArray(payments.status, ["paid", "partially_refunded", "refunded", "disputed"]),
  )).returning({ id: payments.id });
  if (!updated) return null;
  if (payment.kind === "tip" && payment.missionReviewId) {
    const tipStatus = status === "canceled" ? "cancelled" : status;
    await db.update(missionReviews).set({ tipStatus }).where(eq(missionReviews.id, payment.missionReviewId));
  }
  if (payment.kind === "booking") await setBookingPaymentStatus(payment, status);
  return { paymentId: payment.id, missionId: payment.missionId, status };
}

export async function recordCheckoutSessionExpired(session: Stripe.Checkout.Session) {
  const db = getDb();
  const [payment] = await db.update(payments).set({
    status: "canceled",
    cancelledAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(payments.stripeCheckoutSessionId, session.id),
    inArray(payments.status, payableStatuses),
  )).returning();
  if (payment?.kind === "booking") await setBookingPaymentStatus(payment, "canceled");
  if (payment?.kind === "tip" && payment.missionReviewId) {
    await db.update(missionReviews).set({ tipStatus: "cancelled" }).where(eq(missionReviews.id, payment.missionReviewId));
  }
  return payment ?? null;
}

export async function recordChargeRefunded(charge: Stripe.Charge) {
  const db = getDb();
  const client = db.$client;
  const now = new Date();
  const [result] = await client.transaction([client`
    WITH locked_payment AS MATERIALIZED (
      SELECT payment.*
      FROM payments AS payment
      WHERE payment.stripe_charge_id = ${charge.id}
      FOR UPDATE OF payment
    ), computed AS (
      SELECT locked_payment.*,
        LEAST(locked_payment.amount_cents, GREATEST(0, ${charge.amount_refunded}))::integer AS next_refunded_amount_cents,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM payment_disputes AS blocking_dispute
            WHERE blocking_dispute.payment_id = locked_payment.id
              AND blocking_dispute.status NOT IN ('won', 'prevented', 'warning_closed')
          ) THEN 'disputed'::payment_transaction_status
          WHEN LEAST(locked_payment.amount_cents, GREATEST(0, ${charge.amount_refunded})) >= locked_payment.amount_cents
            THEN 'refunded'::payment_transaction_status
          WHEN LEAST(locked_payment.amount_cents, GREATEST(0, ${charge.amount_refunded})) > 0
            THEN 'partially_refunded'::payment_transaction_status
          ELSE 'paid'::payment_transaction_status
        END AS next_status
      FROM locked_payment
    ), updated_payment AS (
      UPDATE payments AS payment
      SET refunded_amount_cents = computed.next_refunded_amount_cents,
          status = computed.next_status,
          disputed_at = CASE
            WHEN computed.next_status = 'disputed'::payment_transaction_status
              THEN COALESCE(payment.disputed_at, ${now})
            ELSE NULL
          END,
          updated_at = ${now}
      FROM computed
      WHERE payment.id = computed.id
      RETURNING payment.id, payment.mission_id, payment.bundle_id, payment.mission_review_id,
        payment.kind, payment.status, payment.refunded_amount_cents
    ), updated_missions AS (
      UPDATE missions AS mission
      SET payment_status = updated_payment.status::text::payment_status,
          updated_at = ${now}
      FROM updated_payment
      WHERE updated_payment.kind = 'booking'
        AND (
          (updated_payment.bundle_id IS NULL AND mission.id = updated_payment.mission_id)
          OR (
            updated_payment.bundle_id IS NOT NULL
            AND mission.bundle_id = updated_payment.bundle_id
            AND mission.archived_at IS NULL
          )
        )
      RETURNING mission.id
    ), updated_bundle AS (
      UPDATE mission_bundles AS bundle
      SET payment_status = updated_payment.status::text::payment_status,
          updated_at = ${now}
      FROM updated_payment
      WHERE updated_payment.kind = 'booking'
        AND updated_payment.bundle_id IS NOT NULL
        AND bundle.id = updated_payment.bundle_id
      RETURNING bundle.id
    ), updated_review AS (
      UPDATE mission_reviews AS review
      SET tip_status = updated_payment.status::text::payment_status
      FROM updated_payment
      WHERE updated_payment.kind = 'tip'
        AND updated_payment.mission_review_id IS NOT NULL
        AND review.id = updated_payment.mission_review_id
      RETURNING review.id
    )
    SELECT id AS payment_id, mission_id, kind, status::text AS status,
      refunded_amount_cents
    FROM updated_payment
  `], { isolationLevel: "Serializable" }) as unknown as [Array<{
    payment_id: string;
    mission_id: string;
    kind: string;
    status: PaymentRecord["status"];
    refunded_amount_cents: number;
  }>];
  const updated = result[0];
  if (updated) await syncRefundedPayment(updated.payment_id);
  return updated ? {
    paymentId: updated.payment_id,
    missionId: updated.mission_id,
    kind: updated.kind,
    status: updated.status,
    refundedAmountCents: Number(updated.refunded_amount_cents),
  } : null;
}

export async function recordRefund(refund: Stripe.Refund) {
  const chargeId = stripeObjectId(refund.charge);
  if (!chargeId) return null;
  const db = getDb();
  const [payment] = await db.select().from(payments).where(eq(payments.stripeChargeId, chargeId)).limit(1);
  if (!payment) return null;
  const status = refund.status === "succeeded" ? "succeeded"
    : refund.status === "failed" ? "failed"
      : refund.status === "canceled" ? "canceled"
        : refund.status === "requires_action" ? "requires_action"
        : "pending";
  const now = new Date();
  const refundKey = refund.metadata?.sendascout_refund_key || `stripe:${refund.id}`;
  const hintedRefundId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(refund.metadata?.sendascout_refund_id ?? "")
    ? refund.metadata!.sendascout_refund_id
    : null;
  const linkExistingRefund = async () => {
    const [linked] = await db.update(paymentRefunds).set({
      stripeRefundId: refund.id,
      status,
      failureCode: refund.failure_reason ?? null,
      failureMessage: refund.failure_balance_transaction ? `Failure balance transaction: ${stripeObjectId(refund.failure_balance_transaction)}` : null,
      refundedAt: status === "succeeded" ? now : null,
      updatedAt: now,
    }).where(and(
      eq(paymentRefunds.paymentId, payment.id),
      eq(paymentRefunds.amountCents, refund.amount),
      eq(paymentRefunds.currency, refund.currency),
      or(
        eq(paymentRefunds.stripeRefundId, refund.id),
        eq(paymentRefunds.idempotencyKey, refundKey),
        hintedRefundId ? eq(paymentRefunds.id, hintedRefundId) : sql`FALSE`,
      ),
      or(isNull(paymentRefunds.stripeRefundId), eq(paymentRefunds.stripeRefundId, refund.id)),
    )).returning({ id: paymentRefunds.id });
    return linked ?? null;
  };
  let saved = await linkExistingRefund();
  if (!saved) try {
    const [inserted] = await db.insert(paymentRefunds).values({
    paymentId: payment.id,
    amountCents: refund.amount,
    currency: refund.currency,
    reason: refund.reason ?? "requested_by_customer",
    stripeRefundId: refund.id,
    idempotencyKey: refundKey,
    status,
    failureCode: refund.failure_reason ?? null,
    failureMessage: refund.failure_balance_transaction ? `Failure balance transaction: ${stripeObjectId(refund.failure_balance_transaction)}` : null,
    refundedAt: status === "succeeded" ? now : null,
    updatedAt: now,
    }).onConflictDoUpdate({
      target: paymentRefunds.stripeRefundId,
      set: {
        status,
        failureCode: refund.failure_reason ?? null,
        failureMessage: refund.failure_balance_transaction ? `Failure balance transaction: ${stripeObjectId(refund.failure_balance_transaction)}` : null,
        refundedAt: status === "succeeded" ? now : null,
        updatedAt: now,
      },
    }).returning({ id: paymentRefunds.id });
    saved = inserted ?? null;
  } catch (error) {
    saved = await linkExistingRefund();
    if (!saved) throw error;
  }
  const [recorded] = saved
    ? await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, saved.id)).limit(1)
    : [null];
  if (!recorded
    || recorded.paymentId !== payment.id
    || recorded.stripeRefundId !== refund.id
    || recorded.amountCents !== refund.amount
    || recorded.currency !== refund.currency) {
    throw new Error(`Stripe refund ${refund.id} conflicts with the durable refund ledger.`);
  }
  if (status === "succeeded") await syncRefundedPayment(payment.id);
  return { paymentId: payment.id, refundId: refund.id, status };
}

export async function recordDispute(dispute: Stripe.Dispute, providerEventCreatedAt: Date) {
  const chargeId = stripeObjectId(dispute.charge);
  if (!chargeId) return null;
  const paymentIntent = typeof dispute.payment_intent === "object" ? dispute.payment_intent : null;
  const paymentIntentId = stripeObjectId(dispute.payment_intent);
  const hintedPaymentId = paymentIntent?.metadata.sendascout_payment_id ?? null;
  const stripeCustomerId = paymentIntent ? stripeObjectId(paymentIntent.customer) : null;
  const latestChargeId = paymentIntent ? stripeObjectId(paymentIntent.latest_charge) : null;
  const earlyLinkEligible = Boolean(
    paymentIntent
    && hintedPaymentId
    && stripeCustomerId
    && paymentIntentId
    && latestChargeId === chargeId
    && paymentIntent.status === "succeeded"
    && paymentIntent.transfer_group,
  );
  const db = getDb();
  const client = db.$client;
  const now = new Date();
  const closed = stripeDisputeIsClosed(dispute.status);
  const [result] = await client.transaction([client`
    WITH locked_payment AS MATERIALIZED (
      SELECT payment.*
      FROM payments AS payment
      WHERE payment.stripe_charge_id = ${chargeId}
        OR (
          ${earlyLinkEligible}
          AND payment.id = ${hintedPaymentId}
          AND (payment.stripe_payment_intent_id IS NULL OR payment.stripe_payment_intent_id = ${paymentIntentId})
          AND (payment.stripe_charge_id IS NULL OR payment.stripe_charge_id = ${chargeId})
          AND payment.amount_cents = ${paymentIntent?.amount_received ?? -1}
          AND payment.currency = ${paymentIntent?.currency ?? ""}
          AND payment.stripe_customer_id = ${stripeCustomerId}
          AND payment.stripe_transfer_group = ${paymentIntent?.transfer_group ?? ""}
          AND payment.mission_id::text = ${paymentIntent?.metadata.sendascout_mission_id ?? ""}
          AND payment.customer_id::text = ${paymentIntent?.metadata.sendascout_customer_id ?? ""}
          AND payment.kind = ${paymentIntent?.metadata.sendascout_payment_kind ?? ""}
          AND (payment.livemode IS NULL OR payment.livemode = ${paymentIntent?.livemode ?? false})
        )
      FOR UPDATE OF payment
    ), saved_dispute AS (
      INSERT INTO payment_disputes (
        payment_id, stripe_dispute_id, stripe_charge_id, amount_cents, currency,
        status, reason, evidence_due_at, provider_event_created_at, opened_at,
        closed_at, updated_at
      )
      SELECT locked_payment.id, ${dispute.id}, ${chargeId}, ${dispute.amount}, ${dispute.currency},
        ${dispute.status}, ${dispute.reason},
        ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null},
        ${providerEventCreatedAt}, ${new Date(dispute.created * 1000)},
        ${closed ? now : null}, ${now}
      FROM locked_payment
      ON CONFLICT (stripe_dispute_id) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents,
          currency = EXCLUDED.currency,
          status = EXCLUDED.status,
          reason = EXCLUDED.reason,
          evidence_due_at = EXCLUDED.evidence_due_at,
          provider_event_created_at = EXCLUDED.provider_event_created_at,
          closed_at = EXCLUDED.closed_at,
          updated_at = EXCLUDED.updated_at
      WHERE payment_disputes.payment_id = EXCLUDED.payment_id
        AND payment_disputes.stripe_charge_id = EXCLUDED.stripe_charge_id
        AND (
          EXCLUDED.provider_event_created_at > payment_disputes.provider_event_created_at
          OR (
            EXCLUDED.provider_event_created_at = payment_disputes.provider_event_created_at
            AND (
              payment_disputes.status NOT IN ('won', 'lost', 'prevented', 'warning_closed')
              OR EXCLUDED.status IN ('won', 'lost', 'prevented', 'warning_closed')
            )
          )
        )
      RETURNING payment_id, stripe_dispute_id, status
    ), computed AS (
      SELECT locked_payment.*,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM payment_disputes AS other_dispute
            WHERE other_dispute.payment_id = locked_payment.id
              AND other_dispute.stripe_dispute_id <> ${dispute.id}
              AND other_dispute.status NOT IN ('won', 'prevented', 'warning_closed')
          ) OR EXISTS (
            SELECT 1
            FROM saved_dispute
            WHERE saved_dispute.status NOT IN ('won', 'prevented', 'warning_closed')
          ) THEN 'disputed'::payment_transaction_status
          WHEN locked_payment.refunded_amount_cents >= locked_payment.amount_cents
            THEN 'refunded'::payment_transaction_status
          WHEN locked_payment.refunded_amount_cents > 0
            THEN 'partially_refunded'::payment_transaction_status
          ELSE 'paid'::payment_transaction_status
        END AS next_status
      FROM locked_payment
      WHERE EXISTS (SELECT 1 FROM saved_dispute)
    ), updated_payment AS (
      UPDATE payments AS payment
      SET status = computed.next_status,
          stripe_payment_intent_id = COALESCE(payment.stripe_payment_intent_id, ${paymentIntentId}),
          stripe_charge_id = COALESCE(payment.stripe_charge_id, ${chargeId}),
          livemode = COALESCE(payment.livemode, ${paymentIntent?.livemode ?? dispute.livemode}),
          paid_at = COALESCE(payment.paid_at, ${now}),
          disputed_at = CASE
            WHEN computed.next_status = 'disputed'::payment_transaction_status
              THEN COALESCE(payment.disputed_at, ${now})
            ELSE NULL
          END,
          updated_at = ${now}
      FROM computed
      WHERE payment.id = computed.id
      RETURNING payment.id, payment.mission_id, payment.bundle_id, payment.mission_review_id,
        payment.kind, payment.status
    ), updated_missions AS (
      UPDATE missions AS mission
      SET payment_status = updated_payment.status::text::payment_status,
          updated_at = ${now}
      FROM updated_payment
      WHERE updated_payment.kind = 'booking'
        AND (
          (updated_payment.bundle_id IS NULL AND mission.id = updated_payment.mission_id)
          OR (
            updated_payment.bundle_id IS NOT NULL
            AND mission.bundle_id = updated_payment.bundle_id
            AND mission.archived_at IS NULL
          )
        )
      RETURNING mission.id
    ), updated_bundle AS (
      UPDATE mission_bundles AS bundle
      SET payment_status = updated_payment.status::text::payment_status,
          updated_at = ${now}
      FROM updated_payment
      WHERE updated_payment.kind = 'booking'
        AND updated_payment.bundle_id IS NOT NULL
        AND bundle.id = updated_payment.bundle_id
      RETURNING bundle.id
    ), updated_review AS (
      UPDATE mission_reviews AS review
      SET tip_status = updated_payment.status::text::payment_status
      FROM updated_payment
      WHERE updated_payment.kind = 'tip'
        AND updated_payment.mission_review_id IS NOT NULL
        AND review.id = updated_payment.mission_review_id
      RETURNING review.id
    )
    SELECT id AS payment_id, mission_id, status::text AS payment_status
    FROM updated_payment
  `], { isolationLevel: "Serializable" }) as unknown as [Array<{
    payment_id: string;
    mission_id: string;
    payment_status: PaymentRecord["status"];
  }>];
  const updated = result[0];
  if (!updated) {
    const [known] = await db.select({
      paymentId: paymentDisputes.paymentId,
      status: paymentDisputes.status,
    }).from(paymentDisputes).where(eq(paymentDisputes.stripeDisputeId, dispute.id)).limit(1);
    return known ? {
      paymentId: known.paymentId,
      disputeId: dispute.id,
      status: known.status,
      ignored: true as const,
    } : null;
  }

  await syncRefundedPayment(updated.payment_id);
  await reconcileStripeDisputeMissionLifecycle(updated.payment_id, dispute);
  return { paymentId: updated.payment_id, disputeId: dispute.id, status: dispute.status, paymentStatus: updated.payment_status };
}

async function setBookingPaymentStatus(payment: PaymentRecord, status: PaymentRecord["status"]) {
  const db = getDb();
  const aggregateStatus = status === "canceled" ? "cancelled" : status;
  if (payment.bundleId) {
    await db.batch([
      db.update(missions).set({ paymentStatus: aggregateStatus, updatedAt: new Date() }).where(and(eq(missions.bundleId, payment.bundleId), isNull(missions.archivedAt))),
      db.update(missionBundles).set({ paymentStatus: aggregateStatus, updatedAt: new Date() }).where(eq(missionBundles.id, payment.bundleId)),
    ]);
  } else {
    await db.update(missions).set({ paymentStatus: aggregateStatus, updatedAt: new Date() }).where(eq(missions.id, payment.missionId));
  }
}

function paymentMetadata(payment: PaymentRecord): Stripe.MetadataParam {
  return {
    sendascout_payment_id: payment.id,
    sendascout_mission_id: payment.missionId,
    sendascout_bundle_id: payment.bundleId ?? "",
    sendascout_customer_id: payment.customerId,
    sendascout_payment_kind: payment.kind,
  };
}

function paymentProductName(kind: string, missionTitle: string) {
  if (kind === "booking") return `Send a Scout mission · ${missionTitle}`;
  if (kind === "meet_adjustment") return `Verified appointment time · ${missionTitle}`;
  if (kind === "change_order") return `Approved additional task · ${missionTitle}`;
  if (kind === "tip") return `Scout tip · ${missionTitle}`;
  return `Mission payment · ${missionTitle}`;
}

function validateCheckoutSession(session: Stripe.Checkout.Session, payment: PaymentRecord) {
  if (
    session.livemode !== payment.livemode
    || stripeObjectId(session.customer) !== payment.stripeCustomerId
    || session.amount_total !== payment.amountCents
    || session.currency !== payment.currency
    || session.metadata?.sendascout_payment_id !== payment.id
  ) {
    throw new Error("Stripe Checkout does not match the payment ledger.");
  }
}

function paymentIntentLedgerStatus(status: Stripe.PaymentIntent.Status): PaymentRecord["status"] {
  if (status === "requires_action" || status === "requires_confirmation") return "requires_action";
  if (status === "processing") return "processing";
  if (status === "canceled") return "canceled";
  if (status === "requires_payment_method") return "failed";
  if (status === "requires_capture") return "authorized";
  return "pending";
}
