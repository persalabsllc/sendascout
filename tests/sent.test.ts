import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { normalizeE164, verifySentWebhook } from "../lib/sent.ts";

test("Sent phone normalization produces E.164 numbers", () => {
  assert.equal(normalizeE164("(252) 555-0123"), "+12525550123");
  assert.equal(normalizeE164("1-252-555-0123"), "+12525550123");
  assert.equal(normalizeE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164("555"), null);
});

test("Sent webhook verification accepts valid signatures and rejects stale payloads", () => {
  const rawBody = JSON.stringify({ type: "message.delivered", payload: { message_id: "msg_123" } });
  const webhookId = "evt_123";
  const timestamp = "1788019200";
  const secretBytes = Buffer.from("send-a-scout-webhook-secret");
  const secret = `whsec_${secretBytes.toString("base64")}`;
  const digest = createHmac("sha256", secretBytes).update(`${webhookId}.${timestamp}.${rawBody}`).digest("base64");
  const signature = `v1,${digest}`;
  assert.equal(verifySentWebhook({ rawBody, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 }), true);
  assert.equal(verifySentWebhook({ rawBody, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 + 5 * 60 * 1000 + 1 }), false);
  assert.equal(verifySentWebhook({ rawBody: `${rawBody} `, webhookId, timestamp, signature, secret, nowMs: Number(timestamp) * 1000 }), false);
});
