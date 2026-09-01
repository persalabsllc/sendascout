import assert from "node:assert/strict";
import test from "node:test";
import { customerPaymentEntryIsVisible } from "../lib/customer-payment-ledger.ts";

type PaymentFixture = Parameters<typeof customerPaymentEntryIsVisible>[1];

function payment(overrides: Partial<PaymentFixture> = {}): PaymentFixture {
  return {
    status: "pending",
    failureCode: null,
    stripePaymentIntentId: null,
    paidAt: null,
    stripeChargeId: null,
    refundedAmountCents: 0,
    ...overrides,
  };
}

test("cancelled missions hide booking rows that never collected money", () => {
  for (const status of ["pending", "requires_action", "failed", "canceled"]) {
    assert.equal(
      customerPaymentEntryIsVisible("cancelled", payment({ status })),
      false,
      `${status} should be hidden after its mission is cancelled`,
    );
  }
  assert.equal(
    customerPaymentEntryIsVisible("cancelled", payment({ status: "processing", failureCode: "checkout_creating" })),
    false,
    "a local Checkout creation claim is not a financial transaction",
  );
});

test("cancelled missions preserve in-flight and financial-history rows", () => {
  for (const status of ["processing", "authorized", "paid", "partially_refunded", "refunded", "disputed"]) {
    assert.equal(
      customerPaymentEntryIsVisible("cancelled", payment({ status })),
      true,
      `${status} should remain visible after its mission is cancelled`,
    );
  }
  assert.equal(
    customerPaymentEntryIsVisible("cancelled", payment({
      status: "processing",
      failureCode: "checkout_creating",
      stripePaymentIntentId: "pi_in_flight",
    })),
    true,
    "provider-backed processing must remain visible",
  );
});

test("payment evidence preserves a cancelled row even when its status is stale", () => {
  const staleRows: PaymentFixture[] = [
    payment({ status: "pending", paidAt: new Date("2026-09-01T00:00:00.000Z") }),
    payment({ status: "failed", stripeChargeId: "ch_test_financial_history" }),
    payment({ status: "canceled", refundedAmountCents: 100 }),
  ];

  for (const staleRow of staleRows) {
    assert.equal(customerPaymentEntryIsVisible("cancelled", staleRow), true);
  }
});

test("non-cancelled mission rows remain visible regardless of payment status", () => {
  for (const missionStatus of ["draft", "open", "claimed", "submitted", "completed", "disputed"]) {
    for (const status of ["pending", "requires_action", "failed", "canceled"]) {
      assert.equal(
        customerPaymentEntryIsVisible(missionStatus, payment({ status })),
        true,
        `${missionStatus}/${status} should remain visible`,
      );
    }
  }
});
