import { createHash } from "node:crypto";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  customerSupportTickets,
  missionCases,
  missions,
  notifications,
  operationalEvents,
  paymentRefunds,
  paymentTransferReversals,
  paymentTransfers,
  payments,
} from "@/db/schema";

export type OperationalSeverity = "warning" | "error" | "critical";

type OperationalInput = {
  severity?: OperationalSeverity;
  category: string;
  message: string;
  context?: Record<string, unknown>;
  fingerprint?: string;
};

const SECRET_KEY = /(authorization|cookie|password|secret|token|api.?key|card|document|license)/i;

function safeValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, childValue]) => [childKey, safeValue(childValue, childKey)]));
  return String(value).slice(0, 1000);
}

function eventFingerprint(input: OperationalInput) {
  const source = input.fingerprint ?? `${input.category}:${input.message}`;
  return createHash("sha256").update(source).digest("hex");
}

function structuredLog(level: OperationalSeverity, message: string, fields: Record<string, unknown>) {
  console.error(JSON.stringify({ level, message, timestamp: new Date().toISOString(), service: "send-a-scout", ...fields }));
}

async function sendOperationsAlert(subject: string, body: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.SENDASCOUT_OPERATIONS_ALERT_EMAILS ?? process.env.SENDASCOUT_ADMIN_EMAILS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!apiKey || recipients.length === 0) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.SENDASCOUT_EMAIL_FROM ?? "Send a Scout <alerts@sendascout.com>",
      to: recipients,
      subject,
      text: body,
    }),
  });
  return response.ok;
}

export async function reportOperationalEvent(input: OperationalInput) {
  const severity = input.severity ?? "error";
  const fingerprint = eventFingerprint(input);
  const context = safeValue(input.context ?? {}) as Record<string, unknown>;
  structuredLog(severity, input.message, { category: input.category, fingerprint, context });

  try {
    const db = getDb();
    const now = new Date();
    const [event] = await db.insert(operationalEvents).values({
      severity,
      category: input.category,
      message: input.message.slice(0, 2000),
      fingerprint,
      contextJson: JSON.stringify(context),
      firstSeenAt: now,
      lastSeenAt: now,
    }).onConflictDoUpdate({
      target: operationalEvents.fingerprint,
      set: {
        severity,
        message: input.message.slice(0, 2000),
        contextJson: JSON.stringify(context),
        status: "open",
        occurrenceCount: sql`${operationalEvents.occurrenceCount} + 1`,
        lastSeenAt: now,
        resolvedAt: null,
      },
    }).returning();

    const alertCooldown = new Date(Date.now() - 60 * 60 * 1000);
    if (!event.alertedAt || event.alertedAt < alertCooldown) {
      const sent = await sendOperationsAlert(
        `[Send a Scout ${severity.toUpperCase()}] ${input.category}`,
        `${input.message}\n\nSeverity: ${severity}\nOccurrences: ${event.occurrenceCount}\nLast seen: ${now.toISOString()}\n\nOpen Control Room: https://sendascout.com/control-room`,
      );
      if (sent) await db.update(operationalEvents).set({ alertedAt: now }).where(eq(operationalEvents.id, event.id));
    }
    return event.id;
  } catch (monitoringError) {
    structuredLog("critical", "Operational monitoring could not persist an event", {
      category: "monitoring_failure",
      originalCategory: input.category,
      error: monitoringError instanceof Error ? monitoringError.message : String(monitoringError),
    });
    return null;
  }
}

export async function reportException(error: unknown, context: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return reportOperationalEvent({
    severity: "error",
    category: "application_exception",
    message,
    fingerprint: `application_exception:${context.route ?? "unknown"}:${message}`,
    context: {
      ...context,
      errorName: error instanceof Error ? error.name : "UnknownError",
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}

export async function runOperationalHealthChecks() {
  const db = getDb();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const caseCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const staleMissionCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const financialCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const intentCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const [
    failedMessages,
    unresolvedCases,
    staleMissions,
    refundExceptions,
    transferExceptions,
    reversalExceptions,
    caseIntentGaps,
    supportIntentGaps,
    latePaymentRefundGaps,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(notifications)
      .where(and(or(eq(notifications.channel, "email"), eq(notifications.channel, "sms")), eq(notifications.status, "failed"), or(gt(notifications.createdAt, hourAgo), gt(notifications.lastAttemptAt, hourAgo)))),
    db.select({ count: sql<number>`count(*)::int` }).from(missionCases)
      .where(and(eq(missionCases.status, "open"), lt(missionCases.createdAt, caseCutoff))),
    db.select({ count: sql<number>`count(*)::int` }).from(missions)
      .where(and(sql`${missions.archivedAt} IS NULL`, sql`${missions.status} IN ('claimed','en_route','onsite','en_route_pickup','at_pickup','en_route_dropoff','at_dropoff')`, lt(missions.updatedAt, staleMissionCutoff))),
    db.select({ count: sql<number>`count(*)::int` }).from(paymentRefunds).where(sql`
      ${paymentRefunds.status} IN ('failed', 'requires_action')
      OR (${paymentRefunds.status} = 'pending' AND ${paymentRefunds.updatedAt} < ${financialCutoff})
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(paymentTransfers).where(sql`
      (${paymentTransfers.status} = 'failed' AND ${paymentTransfers.attemptCount} >= 3)
      OR (${paymentTransfers.status} = 'processing' AND ${paymentTransfers.updatedAt} < ${financialCutoff})
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(paymentTransferReversals).where(sql`
      ${paymentTransferReversals.status} IN ('failed', 'requires_action')
      OR (${paymentTransferReversals.status} = 'pending' AND ${paymentTransferReversals.updatedAt} < ${financialCutoff})
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(missionCases).where(sql`
      ${missionCases.status} = 'resolved'
      AND ${missionCases.updatedAt} < ${intentCutoff}
      AND (
        (
          ${missionCases.refundAmountCents} > 0
          AND COALESCE((
            SELECT SUM(case_refund.amount_cents)
            FROM payment_refunds AS case_refund
            WHERE case_refund.mission_case_id = ${missionCases.id}
          ), 0) < ${missionCases.refundAmountCents}
        )
        OR (
          ${missionCases.payoutAmountCents} > 0
          AND COALESCE((
            SELECT SUM(case_transfer.amount_cents)
            FROM payment_transfers AS case_transfer
            WHERE case_transfer.idempotency_key LIKE
              ('transfer:case:' || ${missionCases.id}::text || ':payment:%')
          ), 0) < ${missionCases.payoutAmountCents}
        )
      )
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(customerSupportTickets).where(sql`
      ${customerSupportTickets.status} = 'closed'
      AND ${customerSupportTickets.customerDecision} = 'approved'
      AND ${customerSupportTickets.resolutionType} IN ('full_refund', 'partial_refund')
      AND ${customerSupportTickets.updatedAt} < ${intentCutoff}
      AND COALESCE((
        SELECT SUM(support_refund.amount_cents)
        FROM payment_refunds AS support_refund
        WHERE support_refund.reason = ('support-ticket:' || ${customerSupportTickets.id}::text)
      ), 0) < ${customerSupportTickets.resolutionAmountCents}
    `),
    db.select({ count: sql<number>`count(*)::int` }).from(payments).where(sql`
      ${payments.failureCode} = 'late_payment_refund_required'
      AND ${payments.updatedAt} < ${intentCutoff}
      AND ${payments.refundedAmountCents} < ${payments.amountCents}
    `),
  ]);

  if ((failedMessages[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "warning", category: "message_delivery", message: `${failedMessages[0].count} email or text notification(s) failed within the last hour.`, fingerprint: "health:failed_messages", context: { count: failedMessages[0].count } });
  if ((unresolvedCases[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "warning", category: "unresolved_cases", message: `${unresolvedCases[0].count} mission case(s) have awaited review for more than one hour.`, fingerprint: "health:unresolved_cases", context: { count: unresolvedCases[0].count } });
  if ((staleMissions[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "warning", category: "stale_missions", message: `${staleMissions[0].count} active mission(s) have not updated for more than 12 hours.`, fingerprint: "health:stale_missions", context: { count: staleMissions[0].count } });
  if ((refundExceptions[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "error", category: "stripe_refunds", message: `${refundExceptions[0].count} refund ledger item(s) require reconciliation or operator review.`, fingerprint: "health:refund_exceptions", context: { count: refundExceptions[0].count } });
  if ((transferExceptions[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "error", category: "stripe_transfers", message: `${transferExceptions[0].count} Scout transfer(s) are stale or have repeatedly failed.`, fingerprint: "health:transfer_exceptions", context: { count: transferExceptions[0].count } });
  if ((reversalExceptions[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "critical", category: "stripe_transfer_reversals", message: `${reversalExceptions[0].count} Scout transfer reversal(s) require reconciliation or operator review.`, fingerprint: "health:reversal_exceptions", context: { count: reversalExceptions[0].count } });
  if ((caseIntentGaps[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "critical", category: "case_financial_intents", message: `${caseIntentGaps[0].count} resolved case(s) are missing part of their durable refund or payout intent.`, fingerprint: "health:case_financial_intent_gaps", context: { count: caseIntentGaps[0].count } });
  if ((supportIntentGaps[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "critical", category: "support_financial_intents", message: `${supportIntentGaps[0].count} approved support refund(s) are missing a durable refund intent.`, fingerprint: "health:support_financial_intent_gaps", context: { count: supportIntentGaps[0].count } });
  if ((latePaymentRefundGaps[0]?.count ?? 0) > 0) await reportOperationalEvent({ severity: "critical", category: "late_payment_refunds", message: `${latePaymentRefundGaps[0].count} late payment(s) have not been fully refunded.`, fingerprint: "health:late_payment_refund_gaps", context: { count: latePaymentRefundGaps[0].count } });

  return {
    failedMessages: failedMessages[0]?.count ?? 0,
    unresolvedCases: unresolvedCases[0]?.count ?? 0,
    staleMissions: staleMissions[0]?.count ?? 0,
    refundExceptions: refundExceptions[0]?.count ?? 0,
    transferExceptions: transferExceptions[0]?.count ?? 0,
    reversalExceptions: reversalExceptions[0]?.count ?? 0,
    caseIntentGaps: caseIntentGaps[0]?.count ?? 0,
    supportIntentGaps: supportIntentGaps[0]?.count ?? 0,
    latePaymentRefundGaps: latePaymentRefundGaps[0]?.count ?? 0,
  };
}
