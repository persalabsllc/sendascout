import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isSentSmsErrorRetryable,
  normalizeE164,
  normalizeSentMessageStatus,
  normalizeSentWebhookEvent,
  sendSentSms,
  SentSmsProviderError,
  verifySentWebhook,
} from "../lib/sent.ts";

const sentSource = readFileSync(new URL("../lib/sent.ts", import.meta.url), "utf8");
const webhookSource = readFileSync(new URL("../app/api/webhooks/sent/route.ts", import.meta.url), "utf8");
const sentDeliveryEventsSource = readFileSync(new URL("../lib/sent-delivery-events.ts", import.meta.url), "utf8");

test("Sent phone normalization produces E.164 numbers", () => {
  assert.equal(normalizeE164("(252) 555-0123"), "+12525550123");
  assert.equal(normalizeE164("1-252-555-0123"), "+12525550123");
  assert.equal(normalizeE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164("555"), null);
});

test("Sent webhook verification accepts signed uppercase events and rejects stale payloads", () => {
  const rawBody = JSON.stringify({
    field: "MESSAGE",
    event: "MESSAGE.DELIVERED",
    payload: { message_id: "msg_123", message_status: "DELIVERED" },
  });
  const webhookId = "evt_123";
  const timestamp = "1788019200";
  const secretBytes = Buffer.from("send-a-scout-webhook-secret");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const digest = createHmac("sha256", secretBytes).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");
  const signature = `v1,${digest}`;
  assert.equal(verifySentWebhook({ rawBody, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 }), true);
  assert.equal(verifySentWebhook({ rawBody, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 + 5 * 60 * 1000 + 1 }), false);
  assert.equal(verifySentWebhook({ rawBody: `${rawBody} `, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 }), false);
  assert.equal(normalizeSentWebhookEvent(" MESSAGE.DELIVERED "), "message.delivered");
  assert.equal(normalizeSentMessageStatus("DELIVERED"), "delivered");
  assert.equal(normalizeSentMessageStatus("MESSAGE.FAILED"), "failed");
  assert.equal(normalizeSentMessageStatus("SENT"), "sent");
  assert.match(webhookSource, /normalizeSentWebhookEvent\(event\.event \?\? event\.type\)/);
  assert.match(webhookSource, /normalizeSentMessageStatus\(event\.payload\?\.message_status \?\? eventType\)/);
  assert.match(webhookSource, /await recordSentMessageEvent\(messageId, status\)/);
  assert.doesNotMatch(webhookSource, /\["sent", "delivered", "read"\]\.includes\(status\)/);
});

test("Sent provider errors preserve status and code while classifying safe retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalMode = process.env.SENT_DM_SMS_MODE;
  const originalKey = process.env.SENT_DM_API_KEY;
  const originalTemplate = process.env.SENT_DM_TEMPLATE_ID;
  process.env.SENT_DM_SMS_MODE = "live";
  process.env.SENT_DM_API_KEY = "sent_test_key";
  process.env.SENT_DM_TEMPLATE_ID = "template_test";
  const input = {
    notificationId: "notification_test",
    to: "+12525550123",
    title: "Mission update",
    body: "Your mission has an update.",
  };

  async function expectProviderError(options: {
    status?: number;
    code?: string;
    network?: boolean;
    ambiguous?: boolean;
    retryable: boolean;
  }) {
    globalThis.fetch = options.network
      ? async () => { throw new TypeError("network unavailable"); }
      : async () => new Response(JSON.stringify(options.ambiguous
        ? { success: true, data: { recipients: [] } }
        : { success: false, error: { code: options.code, message: "Sent rejected this request." } }), {
        status: options.status,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(sendSentSms(input), (error: unknown) => {
      assert.ok(error instanceof SentSmsProviderError);
      assert.equal(error.httpStatus, options.network ? null : options.status);
      assert.equal(error.providerCode, options.code ?? null);
      assert.equal(error.retryable, options.retryable);
      assert.equal(isSentSmsErrorRetryable(error), options.retryable);
      return true;
    });
  }

  try {
    await expectProviderError({ network: true, retryable: true });
    await expectProviderError({ status: 429, code: "RATE_LIMITED", retryable: true });
    await expectProviderError({ status: 503, code: "UPSTREAM_UNAVAILABLE", retryable: true });
    await expectProviderError({ status: 200, ambiguous: true, retryable: true });
    await expectProviderError({ status: 422, code: "VALIDATION_002", retryable: false });
    assert.match(sentSource, /options\.httpStatus === 429/);
    assert.match(sentSource, /options\.httpStatus >= 500/);
    assert.match(sentSource, /Sent returned an ambiguous response without a message ID/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMode === undefined) delete process.env.SENT_DM_SMS_MODE;
    else process.env.SENT_DM_SMS_MODE = originalMode;
    if (originalKey === undefined) delete process.env.SENT_DM_API_KEY;
    else process.env.SENT_DM_API_KEY = originalKey;
    if (originalTemplate === undefined) delete process.env.SENT_DM_TEMPLATE_ID;
    else process.env.SENT_DM_TEMPLATE_ID = originalTemplate;
  }
});

test("Sent delivery events can update only SMS notification rows", () => {
  const providerUpdates = sentDeliveryEventsSource.match(/where\(and\([\s\S]*?eq\(notifications\.channel, "sms"\),[\s\S]*?\)\)\.returning/g) ?? [];
  assert.equal(providerUpdates.length, 2);
});
