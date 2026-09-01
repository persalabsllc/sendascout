import { inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { recordSentMessageEvent } from "@/lib/sent-delivery-events";
import {
  normalizeE164,
  normalizeSentMessageStatus,
  normalizeSentWebhookEvent,
  verifySentWebhook,
} from "@/lib/sent";

export const runtime = "nodejs";

type SentEvent = {
  type?: string;
  event?: string;
  payload?: {
    message_id?: string;
    message_status?: string;
    inbound_number?: string;
    text?: string;
  };
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.SENT_DM_WEBHOOK_SECRET ?? "";
  const valid = verifySentWebhook({
    rawBody,
    webhookId: request.headers.get("x-webhook-id"),
    timestamp: request.headers.get("x-webhook-timestamp"),
    signature: request.headers.get("x-webhook-signature"),
    secret,
  });
  if (!valid) return Response.json({ error: "Invalid webhook signature." }, { status: 401 });

  let event: SentEvent;
  try { event = JSON.parse(rawBody) as SentEvent; }
  catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }

  const db = getDb();
  const eventType = normalizeSentWebhookEvent(event.event ?? event.type);
  const messageId = event.payload?.message_id;
  const status = normalizeSentMessageStatus(event.payload?.message_status ?? eventType);
  if (messageId && eventType !== "message.received") {
    await recordSentMessageEvent(messageId, status);
  }

  if (eventType === "message.received") {
    const contact = normalizeE164(event.payload?.inbound_number);
    const keyword = event.payload?.text?.trim().toUpperCase();
    if (contact && keyword) {
      const rows = await db.select({ id: users.id, phone: users.phone, consentedAt: users.smsConsentedAt }).from(users);
      const matchingUserIds = rows.filter((row) => normalizeE164(row.phone) === contact).map((row) => row.id);
      if (matchingUserIds.length && ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
        await db.update(users).set({ smsNotificationsEnabled: false, updatedAt: new Date() })
          .where(inArray(users.id, matchingUserIds));
      } else if (matchingUserIds.length && ["START", "UNSTOP", "SUBSCRIBE"].includes(keyword)) {
        const now = new Date();
        await db.update(users).set({
          smsNotificationsEnabled: true,
          smsConsentedAt: sql`COALESCE(${users.smsConsentedAt}, ${now})`,
          updatedAt: now,
        }).where(inArray(users.id, matchingUserIds));
      }
    }
  }
  return Response.json({ received: true });
}
