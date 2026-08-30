import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { notifications, users } from "@/db/schema";
import { normalizeE164, verifySentWebhook } from "@/lib/sent";

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
  const eventType = event.type ?? event.event ?? "";
  const messageId = event.payload?.message_id;
  const status = event.payload?.message_status ?? eventType.replace("message.", "");
  if (messageId && eventType !== "message.received") {
    if (["sent", "delivered", "read"].includes(status)) {
      await db.update(notifications).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(notifications.providerMessageId, messageId));
    } else if (["failed", "blocked", "filtered"].includes(status)) {
      await db.update(notifications).set({ status: "failed", error: `Sent reported ${status}.` }).where(eq(notifications.providerMessageId, messageId));
    }
  }

  if (eventType === "message.received") {
    const contact = normalizeE164(event.payload?.inbound_number);
    const keyword = event.payload?.text?.trim().toUpperCase();
    if (contact && keyword) {
      const rows = await db.select({ id: users.id, phone: users.phone, consentedAt: users.smsConsentedAt }).from(users);
      const user = rows.find((row) => normalizeE164(row.phone) === contact);
      if (user && ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
        await db.update(users).set({ smsNotificationsEnabled: false, updatedAt: new Date() }).where(eq(users.id, user.id));
      } else if (user && ["START", "UNSTOP", "SUBSCRIBE"].includes(keyword)) {
        await db.update(users).set({ smsNotificationsEnabled: true, smsConsentedAt: user.consentedAt ?? new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
      }
    }
  }
  return Response.json({ received: true });
}
