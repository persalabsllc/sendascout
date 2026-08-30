import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnalyticsSnapshot,
  type AnalyticsBundleRow,
  type AnalyticsMissionRow,
} from "../app/control-room/analytics/metrics.ts";

const createdAt = new Date("2026-08-30T12:00:00.000Z");
const claimedAt = new Date("2026-08-30T12:10:00.000Z");
const completedAt = new Date("2026-08-30T14:00:00.000Z");

function mission(overrides: Partial<AnalyticsMissionRow>): AnalyticsMissionRow {
  return {
    customerId: "customer-1",
    scoutId: "scout-1",
    bundleId: null,
    bundleSequence: null,
    type: "see",
    status: "completed",
    customerPriceCents: 2900,
    scoutPayoutCents: 1800,
    platformFeeCents: 1100,
    bundleDiscountCents: 0,
    preferredScoutId: null,
    enhancedReportRequested: false,
    proofOfDeliveryRequired: false,
    deliveryPinRequired: false,
    claimedAt,
    completedAt,
    createdAt,
    ...overrides,
  };
}

test("analytics count a multipart bundle once financially but include both mission legs in mix", () => {
  const bundle: AnalyticsBundleRow = {
    id: "bundle-1",
    customerId: "customer-1",
    status: "completed",
    customerPriceCents: 4400,
    scoutPayoutCents: 3000,
    platformFeeCents: 1400,
    bundleDiscountCents: 400,
    completedAt,
    createdAt,
  };
  const snapshot = buildAnalyticsSnapshot({
    missions: [
      mission({}),
      mission({ customerId: "customer-2", type: "meet", status: "cancelled", completedAt: null }),
      mission({
        bundleId: bundle.id,
        bundleSequence: 1,
        type: "meet",
        customerPriceCents: 2900,
        scoutPayoutCents: 2000,
        platformFeeCents: 900,
        preferredScoutId: "scout-1",
      }),
      mission({
        bundleId: bundle.id,
        bundleSequence: 2,
        type: "move",
        customerPriceCents: 1500,
        scoutPayoutCents: 1000,
        platformFeeCents: 500,
        claimedAt: new Date("2026-08-30T14:00:00.000Z"),
        proofOfDeliveryRequired: true,
        deliveryPinRequired: true,
      }),
    ],
    bundles: [bundle],
    payments: [
      { status: "paid", amountCents: 7300 },
      { status: "authorized", amountCents: 4400 },
      { status: "refunded", amountCents: 500 },
    ],
    changeOrders: [],
    activeTemplates: 0,
    recurrences: [],
    businessAccounts: 0,
    generatedAt: new Date("2026-08-30T15:00:00.000Z"),
  });

  assert.deepEqual(snapshot.financial, {
    bookedValueCents: 7300,
    collectedRevenueCents: 7300,
    projectedScoutPayoutCents: 4800,
    projectedPlatformFeeCents: 2500,
    bundleDiscountCents: 400,
  });
  assert.equal(snapshot.operations.totalOrders, 3);
  assert.equal(snapshot.operations.completedOrders, 2);
  assert.equal(snapshot.operations.cancelledOrders, 1);
  assert.equal(snapshot.operations.repeatCustomers, 1);
  assert.equal(snapshot.operations.repeatCustomerRate, 1);
  assert.deepEqual(snapshot.missionMix, [
    { type: "see", count: 1, percent: 33 },
    { type: "move", count: 1, percent: 33 },
    { type: "meet", count: 1, percent: 33 },
  ]);
  assert.equal(snapshot.features.multipartBundles, 1);
  assert.equal(snapshot.features.preferredOffers, 1);
  assert.equal(snapshot.features.preferredConversions, 1);
  assert.equal(snapshot.features.proofOfDeliveryMissions, 1);
  assert.equal(snapshot.features.pinProtectedMissions, 1);
});
