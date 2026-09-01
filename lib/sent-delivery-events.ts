import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications, sentMessageEvents } from "@/db/schema";
import { normalizeSentMessageStatus } from "@/lib/sent";

const DELIVERED_STATUSES = ["delivered", "read"];
const FAILED_STATUSES = ["failed", "blocked", "filtered"];

function sentFailureMessage(status: string) {
  return `Sent reported ${status}.`;
}

/**
 * Applies the strongest provider state currently known for one Sent message.
 * The provider event is stored independently from the notification mapping so
 * a webhook that wins the race against the send response cannot be lost.
 */
export async function applyStoredSentMessageEvent(messageId: string) {
  const db = getDb();
  const [event] = await db.select({
    status: sentMessageEvents.status,
    error: sentMessageEvents.error,
  }).from(sentMessageEvents).where(eq(sentMessageEvents.messageId, messageId)).limit(1);
  if (!event) return false;
  if (DELIVERED_STATUSES.includes(event.status)) {
    const updated = await db.update(notifications).set({
      status: "sent",
      sentAt: new Date(),
      error: null,
    }).where(and(
      eq(notifications.providerMessageId, messageId),
      eq(notifications.channel, "sms"),
    )).returning({ id: notifications.id });
    if (updated.length > 0) await db.update(sentMessageEvents).set({ appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(sentMessageEvents.messageId, messageId));
    return updated.length > 0;
  }
  if (FAILED_STATUSES.includes(event.status)) {
    const updated = await db.update(notifications).set({
      status: "failed",
      error: event.error ?? sentFailureMessage(event.status),
    }).where(and(
      eq(notifications.providerMessageId, messageId),
      eq(notifications.channel, "sms"),
    )).returning({ id: notifications.id });
    if (updated.length > 0) await db.update(sentMessageEvents).set({ appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(sentMessageEvents.messageId, messageId));
    return updated.length > 0;
  }
  return false;
}

export async function recordSentMessageEvent(messageId: string, rawStatus: string) {
  const db = getDb();
  const status = normalizeSentMessageStatus(rawStatus);
  if (!messageId || !status) return false;
  const now = new Date();
  await db.insert(sentMessageEvents).values({
    messageId,
    status,
    error: FAILED_STATUSES.includes(status) ? sentFailureMessage(status) : null,
    receivedAt: now,
    appliedAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: sentMessageEvents.messageId,
    set: {
      status: sql`CASE
        WHEN EXCLUDED.status IN ('delivered', 'read') THEN EXCLUDED.status
        WHEN ${sentMessageEvents.status} IN ('delivered', 'read') THEN ${sentMessageEvents.status}
        WHEN EXCLUDED.status IN ('failed', 'blocked', 'filtered') THEN EXCLUDED.status
        WHEN ${sentMessageEvents.status} IN ('failed', 'blocked', 'filtered') THEN ${sentMessageEvents.status}
        ELSE EXCLUDED.status
      END`,
      error: sql`CASE
        WHEN EXCLUDED.status IN ('delivered', 'read') THEN NULL
        WHEN ${sentMessageEvents.status} IN ('delivered', 'read') THEN NULL
        WHEN EXCLUDED.status IN ('failed', 'blocked', 'filtered') THEN EXCLUDED.error
        ELSE ${sentMessageEvents.error}
      END`,
      appliedAt: null,
      updatedAt: now,
    },
  });
  return applyStoredSentMessageEvent(messageId);
}

/** Recovers a webhook that committed before its notification mapping existed. */
export async function reconcileStoredSentMessageEvents() {
  const rows = await getDb().select({ messageId: sentMessageEvents.messageId })
    .from(sentMessageEvents)
    .where(and(
      isNull(sentMessageEvents.appliedAt),
      inArray(sentMessageEvents.status, [...DELIVERED_STATUSES, ...FAILED_STATUSES]),
    ));
  let applied = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      if (await applyStoredSentMessageEvent(row.messageId)) applied += 1;
    } catch (error) {
      errors += 1;
      console.error("Stored Sent delivery event reconciliation failed", {
        messageId: row.messageId,
        error: error instanceof Error ? error.message : "Unknown Sent reconciliation error",
      });
    }
  }
  return { found: rows.length, applied, errors };
}
