import "server-only";

import type Stripe from "stripe";
import { getDb } from "@/db";
import { reportOperationalEvent } from "@/lib/observability";
import { stripeDisputeIsClosed } from "@/lib/stripe-dispute-core";

type LifecycleResult = {
  action: "created" | "attached" | "resolved" | "archived" | "inconsistent" | "missing";
  missionId?: string;
  caseId?: string;
};

function disputeIdentityMarker(dispute: Stripe.Dispute) {
  return `[Stripe dispute ${dispute.id}]`;
}

function disputeStatusMarker(dispute: Stripe.Dispute) {
  return `${disputeIdentityMarker(dispute)} [provider status: ${dispute.status}]`;
}

function disputeNote(dispute: Stripe.Dispute) {
  const marker = disputeStatusMarker(dispute);
  if (stripeDisputeIsClosed(dispute.status)) {
    return `${marker} Stripe reported the provider outcome. Keep the mission paused until Control Room explicitly resolves the lifecycle and any refund or Scout payout adjustment. No Scout transfer reversal was created automatically.`;
  }
  const deadline = dispute.evidence_details?.due_by
    ? ` Evidence is due by ${new Date(dispute.evidence_details.due_by * 1000).toISOString()}.`
    : "";
  return `${marker} Stripe reported an active payment dispute.${deadline} Preserve the mission record and review the provider evidence deadline. No Scout transfer reversal was created automatically.`;
}

/**
 * Places the operational mission scope under review for a Stripe dispute.
 * Provider outcomes are recorded on the open case, but never choose a service
 * outcome, refund, payout, or transfer reversal on an administrator's behalf.
 */
export async function reconcileStripeDisputeMissionLifecycle(paymentId: string, dispute: Stripe.Dispute) {
  const db = getDb();
  const client = db.$client;
  const note = disputeNote(dispute);
  const identityMarker = disputeIdentityMarker(dispute);
  const marker = disputeStatusMarker(dispute);
  const now = new Date();
  const caseId = crypto.randomUUID();
  const closed = stripeDisputeIsClosed(dispute.status);
  const [rows] = await client.transaction([client`
    WITH payment_scope AS MATERIALIZED (
      SELECT payment.customer_id, source_mission.id AS source_mission_id,
        source_mission.bundle_id, bundle.active_sequence,
        CASE
          WHEN source_mission.bundle_id IS NULL THEN source_mission.id
          ELSE active_leg.id
        END AS target_mission_id
      FROM payments AS payment
      INNER JOIN missions AS source_mission ON source_mission.id = payment.mission_id
      LEFT JOIN mission_bundles AS bundle ON bundle.id = source_mission.bundle_id
      LEFT JOIN missions AS active_leg
        ON active_leg.bundle_id = bundle.id
        AND active_leg.bundle_sequence = bundle.active_sequence
      WHERE payment.id = ${paymentId}
    ), locked_mission AS MATERIALIZED (
      SELECT target_mission.*
      FROM payment_scope
      INNER JOIN missions AS target_mission ON target_mission.id = payment_scope.target_mission_id
      FOR UPDATE OF target_mission
    ), locked_bundle AS MATERIALIZED (
      SELECT bundle.*
      FROM locked_mission
      INNER JOIN mission_bundles AS bundle ON bundle.id = locked_mission.bundle_id
      FOR UPDATE OF bundle
    ), eligible_scope AS MATERIALIZED (
      SELECT locked_mission.*, locked_bundle.status AS bundle_status
      FROM locked_mission
      LEFT JOIN locked_bundle ON locked_bundle.id = locked_mission.bundle_id
      WHERE locked_mission.bundle_id IS NULL
        OR (
          locked_bundle.id IS NOT NULL
          AND locked_bundle.active_sequence = locked_mission.bundle_sequence
        )
    ), existing_case AS MATERIALIZED (
      SELECT review_case.id, review_case.mission_id, review_case.admin_notes
      FROM mission_cases AS review_case
      INNER JOIN missions AS case_mission ON case_mission.id = review_case.mission_id
      INNER JOIN eligible_scope ON (
        (eligible_scope.bundle_id IS NULL AND review_case.mission_id = eligible_scope.id)
        OR (
          eligible_scope.bundle_id IS NOT NULL
          AND case_mission.bundle_id = eligible_scope.bundle_id
        )
      )
      WHERE review_case.status = 'open'
      ORDER BY
        CASE WHEN POSITION(${identityMarker} IN COALESCE(review_case.admin_notes, '')) > 0 THEN 0 ELSE 1 END,
        review_case.created_at
      LIMIT 1
    ), resolved_provider_case AS MATERIALIZED (
      SELECT review_case.id, review_case.mission_id
      FROM mission_cases AS review_case
      INNER JOIN missions AS case_mission ON case_mission.id = review_case.mission_id
      INNER JOIN eligible_scope ON (
        (eligible_scope.bundle_id IS NULL AND review_case.mission_id = eligible_scope.id)
        OR (
          eligible_scope.bundle_id IS NOT NULL
          AND case_mission.bundle_id = eligible_scope.bundle_id
        )
      )
      WHERE ${closed}
        AND review_case.status = 'resolved'
        AND POSITION(${marker} IN COALESCE(review_case.admin_notes, '')) > 0
      ORDER BY review_case.resolved_at DESC NULLS LAST
      LIMIT 1
    ), classification AS MATERIALIZED (
      SELECT eligible_scope.*,
        CASE
          WHEN EXISTS (SELECT 1 FROM resolved_provider_case) THEN 'resolved'
          WHEN eligible_scope.archived_at IS NOT NULL THEN 'archived'
          WHEN EXISTS (SELECT 1 FROM existing_case) THEN 'attached'
          WHEN eligible_scope.status = 'disputed'
            OR eligible_scope.bundle_status = 'disputed'
            THEN 'inconsistent'
          ELSE 'create'
        END AS action
      FROM eligible_scope
    ), attached_note AS (
      UPDATE mission_cases AS review_case
      SET admin_notes = CONCAT_WS(E'\n\n', NULLIF(review_case.admin_notes, ''), ${note}::text),
          updated_at = ${now}
      FROM existing_case, classification
      WHERE review_case.id = existing_case.id
        AND classification.action = 'attached'
        AND NOT EXISTS (SELECT 1 FROM resolved_provider_case)
        AND POSITION(${marker} IN COALESCE(review_case.admin_notes, '')) = 0
      RETURNING review_case.id
    ), paused_mission AS (
      UPDATE missions AS mission
      SET status = 'disputed',
          location_sharing_active = FALSE,
          scout_latitude = NULL,
          scout_longitude = NULL,
          scout_location_accuracy_meters = NULL,
          scout_location_updated_at = NULL,
          updated_at = ${now}
      FROM classification
      WHERE classification.action IN ('create', 'attached')
        AND mission.id = classification.id
        AND mission.status = classification.status
        AND mission.archived_at IS NULL
      RETURNING mission.id
    ), paused_bundle AS (
      UPDATE mission_bundles AS bundle
      SET status = 'disputed', updated_at = ${now}
      FROM classification
      WHERE classification.action IN ('create', 'attached')
        AND classification.bundle_id IS NOT NULL
        AND bundle.id = classification.bundle_id
        AND bundle.status = classification.bundle_status
        AND EXISTS (SELECT 1 FROM paused_mission)
      RETURNING bundle.id
    ), created_case AS (
      INSERT INTO mission_cases (
        id, mission_id, reporter_id, kind, status, previous_mission_status,
        summary, admin_notes, updated_at
      )
      SELECT ${caseId}, classification.id, classification.customer_id,
        'stripe_payment_dispute', 'open', classification.status::text,
        ${`Stripe reported a payment dispute (${dispute.id}). The mission and related payout are paused for Control Room review.`},
        ${note}, ${now}
      FROM classification
      WHERE classification.action = 'create'
        AND EXISTS (SELECT 1 FROM paused_mission)
        AND (
          classification.bundle_id IS NULL
          OR EXISTS (SELECT 1 FROM paused_bundle)
        )
      RETURNING id, mission_id
    ), audited AS (
      INSERT INTO mission_updates (mission_id, author_id, status, message)
      SELECT paused_mission.id, NULL, 'disputed',
        'Stripe reported a payment dispute. The mission and related payout are paused for Control Room review.'
      FROM paused_mission
      INNER JOIN classification ON classification.id = paused_mission.id
      WHERE (
          (
            classification.action = 'create'
            AND EXISTS (SELECT 1 FROM created_case)
          ) OR (
            classification.action = 'attached'
            AND (
              EXISTS (SELECT 1 FROM attached_note)
              OR classification.status <> 'disputed'
              OR (
                classification.bundle_id IS NOT NULL
                AND classification.bundle_status <> 'disputed'
              )
            )
          )
        )
        AND (
          classification.bundle_id IS NULL
          OR EXISTS (SELECT 1 FROM paused_bundle)
        )
      RETURNING id
    ), notified AS (
      INSERT INTO notifications (
        recipient_user_id, mission_id, channel, status, kind, title, body,
        action_label, action_url, sent_at
      )
      SELECT DISTINCT recipient.user_id, created_case.mission_id,
        'in_app', 'sent', 'payment_dispute_review_opened',
        'Mission paused for payment review',
        'Stripe reported a payment dispute. Control Room will review the provider record before the mission or related payout continues.',
        'View mission',
        CONCAT('https://sendascout.com/dashboard/missions/', created_case.mission_id::text),
        ${now}
      FROM created_case
      INNER JOIN classification ON classification.id = created_case.mission_id
      CROSS JOIN LATERAL (
        SELECT user_id
        FROM (VALUES (classification.customer_id), (classification.scout_id)) AS participant(user_id)
        WHERE user_id IS NOT NULL
      ) AS recipient
      RETURNING id
    ), outcome AS (
      SELECT COALESCE((SELECT action FROM classification), 'missing') AS action,
        (SELECT id FROM classification) AS mission_id,
        CASE
          WHEN (SELECT action FROM classification) = 'create' THEN (SELECT id FROM created_case)
          WHEN (SELECT action FROM classification) = 'resolved' THEN (SELECT id FROM resolved_provider_case)
          ELSE (SELECT id FROM existing_case)
        END AS case_id
    ), validated AS (
      SELECT outcome.*,
        CASE
          WHEN outcome.action = 'create' THEN
            (SELECT COUNT(*) FROM paused_mission) = 1
            AND (SELECT COUNT(*) FROM created_case) = 1
            AND (SELECT COUNT(*) FROM audited) = 1
            AND (
              (SELECT bundle_id FROM classification) IS NULL
              OR (SELECT COUNT(*) FROM paused_bundle) = 1
            )
          WHEN outcome.action = 'attached' THEN
            (SELECT COUNT(*) FROM paused_mission) = 1
            AND (SELECT COUNT(*) FROM created_case) = 0
            AND (
              (SELECT bundle_id FROM classification) IS NULL
              OR (SELECT COUNT(*) FROM paused_bundle) = 1
            )
          ELSE
            (SELECT COUNT(*) FROM paused_mission) = 0
            AND (SELECT COUNT(*) FROM paused_bundle) = 0
            AND (SELECT COUNT(*) FROM created_case) = 0
            AND (SELECT COUNT(*) FROM audited) = 0
        END AS valid
      FROM outcome
    )
    SELECT CASE
      WHEN valid THEN CASE WHEN action = 'create' THEN 'created' ELSE action END
      ELSE (
        1 / (
          (SELECT COUNT(*)::integer FROM created_case)
          - (SELECT COUNT(*)::integer FROM created_case)
        )
      )::text
    END AS action, mission_id::text, case_id::text
    FROM validated
  `], { isolationLevel: "Serializable" }) as unknown as [Array<{
    action: LifecycleResult["action"];
    mission_id: string | null;
    case_id: string | null;
  }>];
  const saved = rows[0];
  const result: LifecycleResult = saved ? {
    action: saved.action,
    missionId: saved.mission_id ?? undefined,
    caseId: saved.case_id ?? undefined,
  } : { action: "missing" };

  if (result.action === "resolved") {
    return result;
  }
  if (result.action === "archived" || result.action === "inconsistent" || result.action === "missing") {
    await reportOperationalEvent({
      severity: "critical",
      category: "stripe_payment_dispute_lifecycle",
      message: `Stripe dispute ${dispute.id} could not create a resolvable mission pause (${result.action}).`,
      fingerprint: `stripe-payment-dispute-lifecycle:${dispute.id}:${result.action}`,
      context: { disputeId: dispute.id, disputeStatus: dispute.status, paymentId, missionId: result.missionId, action: result.action },
    });
  } else if (result.action === "created" || result.action === "attached" || stripeDisputeIsClosed(dispute.status)) {
    await reportOperationalEvent({
      severity: "warning",
      category: "stripe_payment_dispute",
      message: stripeDisputeIsClosed(dispute.status)
        ? `Stripe dispute ${dispute.id} reported provider status ${dispute.status}; its mission remains paused for an explicit Control Room decision.`
        : `Stripe dispute ${dispute.id} paused mission ${result.missionId ?? "unknown"} and its related payout.`,
      fingerprint: `stripe-payment-dispute:${dispute.id}`,
      context: { disputeId: dispute.id, disputeStatus: dispute.status, paymentId, missionId: result.missionId, caseId: result.caseId },
    });
  }

  return result;
}
