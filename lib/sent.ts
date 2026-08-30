import { createHmac, timingSafeEqual } from "node:crypto";

export type SentMode = "disabled" | "sandbox" | "live";

export function getSentMode(): SentMode {
  const value = process.env.SENT_DM_SMS_MODE?.toLowerCase();
  return value === "sandbox" || value === "live" ? value : "disabled";
}

export function isSentConfigured() {
  return getSentMode() !== "disabled" && Boolean(process.env.SENT_DM_API_KEY && process.env.SENT_DM_TEMPLATE_ID);
}

export function normalizeE164(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export async function sendSentSms(input: {
  notificationId: string;
  to: string;
  title: string;
  body: string;
  actionUrl?: string | null;
}) {
  const apiKey = process.env.SENT_DM_API_KEY;
  const templateId = process.env.SENT_DM_TEMPLATE_ID;
  const mode = getSentMode();
  if (mode === "disabled" || !apiKey || !templateId) throw new Error("Sent SMS delivery is not configured.");
  const to = normalizeE164(input.to);
  if (!to) throw new Error("The recipient does not have a valid mobile number.");

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Idempotency-Key": `sendascout-${input.notificationId}`,
    },
    body: JSON.stringify({
      to: [to],
      channel: ["sms"],
      template: {
        id: templateId,
        parameters: {
          title: input.title,
          body: input.body,
          action_url: input.actionUrl ?? "https://sendascout.com/dashboard",
        },
      },
      sandbox: mode === "sandbox",
    }),
  });
  const result = await response.json().catch(() => null) as {
    data?: { recipients?: Array<{ message_id?: string }> };
    message?: string;
    error?: { message?: string };
  } | null;
  const messageId = result?.data?.recipients?.[0]?.message_id;
  if (!response.ok || !messageId) throw new Error(result?.error?.message || result?.message || `Sent rejected the message (${response.status}).`);
  return messageId;
}

export function verifySentWebhook(input: {
  rawBody: string;
  webhookId: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  nowMs?: number;
}) {
  const { rawBody, webhookId, timestamp, signature, secret } = input;
  if (!webhookId || !timestamp || !signature || !secret) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs((input.nowMs ?? Date.now()) - timestampSeconds * 1000) > 5 * 60 * 1000) return false;
  const supplied = signature.startsWith("v1,") ? signature.slice(3) : "";
  if (!supplied) return false;
  try {
    const secretValue = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const key = Buffer.from(secretValue, "base64");
    const expected = createHmac("sha256", key).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
