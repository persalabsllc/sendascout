import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { customerSupportReasonLabel, customerSupportResolutionLabel, validSupportResolutionAmount } from "../lib/customer-support-core.ts";

const supportActions = readFileSync(new URL("../app/actions/support.ts", import.meta.url), "utf8");
const customerShell = readFileSync(new URL("../components/customer-dashboard-shell.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../components/dashboard.tsx", import.meta.url), "utf8");
const controlRoom = readFileSync(new URL("../components/control-room.tsx", import.meta.url), "utf8");
const footer = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("customer support labels remain explicit and customer-facing", () => {
  assert.equal(customerSupportReasonLabel("delivery_problem"), "Delivery problem or damaged item");
  assert.equal(customerSupportResolutionLabel("account_credit"), "Send a Scout credit");
});

test("support resolution amounts respect refundable and credit limits", () => {
  assert.equal(validSupportResolutionAmount("full_refund", 1, 2900, 2900), 2900);
  assert.equal(validSupportResolutionAmount("partial_refund", 1400, 2900, 2900), 1400);
  assert.equal(validSupportResolutionAmount("partial_refund", 3000, 2900, 2900), null);
  assert.equal(validSupportResolutionAmount("account_credit", 1000, 0, 2900), 1000);
  assert.equal(validSupportResolutionAmount("account_credit", 3000, 0, 2900), null);
});

test("customer approval is the only action that closes a proposed ticket and issues credit", () => {
  assert.match(supportActions, /status = 'closed', customer_decision = 'approved'/);
  assert.match(supportActions, /WHERE id = \$\{ticketId\} AND customer_id = \$\{customer\.id\} AND status = 'awaiting_customer'/);
  assert.match(supportActions, /INSERT INTO customer_credits/);
  assert.match(supportActions, /WHERE resolution_type = 'account_credit'/);
});

test("customer and admin navigation expose the separate support center", () => {
  assert.match(customerShell, /Contact Support/);
  assert.match(customerShell, /dashboard\/customer\/support/);
  assert.match(dashboard, /Contact Support/);
  assert.match(dashboard, /dashboard\/customer\/support/);
  assert.match(controlRoom, /control-room\/support/);
});

test("public footer names the LLC", () => {
  assert.match(footer, /© 2026 Send a Scout LLC\./);
});
