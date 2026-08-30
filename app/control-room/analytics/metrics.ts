export type AnalyticsMissionRow = {
  customerId: string;
  scoutId: string | null;
  bundleId: string | null;
  bundleSequence: number | null;
  type: "see" | "move" | "meet";
  status: string;
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  bundleDiscountCents: number;
  preferredScoutId: string | null;
  enhancedReportRequested: boolean;
  proofOfDeliveryRequired: boolean;
  deliveryPinRequired: boolean;
  claimedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type AnalyticsBundleRow = {
  id: string;
  customerId: string;
  status: string;
  customerPriceCents: number;
  scoutPayoutCents: number;
  platformFeeCents: number;
  bundleDiscountCents: number;
  completedAt: Date | null;
  createdAt: Date;
};

export type AnalyticsPaymentRow = {
  status: string;
  amountCents: number;
};

export type AnalyticsChangeOrderRow = {
  kind: string;
  status: string;
  customerDeltaCents: number;
};

export type AnalyticsSnapshot = {
  generatedAt: string;
  financial: {
    bookedValueCents: number;
    collectedRevenueCents: number;
    projectedScoutPayoutCents: number;
    projectedPlatformFeeCents: number;
    bundleDiscountCents: number;
  };
  operations: {
    totalOrders: number;
    activeOrders: number;
    completedOrders: number;
    cancelledOrders: number;
    orderingCustomers: number;
    repeatCustomers: number;
    repeatCustomerRate: number;
    averageOrderCents: number;
    averageMinutesToClaim: number | null;
    claimSampleSize: number;
    averageHoursToComplete: number | null;
    completionSampleSize: number;
  };
  missionMix: Array<{
    type: "see" | "move" | "meet";
    count: number;
    percent: number;
  }>;
  features: {
    activeTemplates: number;
    activeRecurrences: number;
    totalRecurrences: number;
    extensionRequests: number;
    acceptedExtensions: number;
    extensionValueCents: number;
    preferredOffers: number;
    preferredConversions: number;
    multipartBundles: number;
    enhancedReports: number;
    proofOfDeliveryMissions: number;
    pinProtectedMissions: number;
    businessAccounts: number;
  };
};

type SnapshotInput = {
  missions: AnalyticsMissionRow[];
  bundles: AnalyticsBundleRow[];
  payments: AnalyticsPaymentRow[];
  changeOrders: AnalyticsChangeOrderRow[];
  activeTemplates: number;
  recurrences: Array<{ status: string }>;
  businessAccounts: number;
  generatedAt?: Date;
};

const finalStatuses = new Set(["completed", "cancelled"]);
const acceptedChangeOrderStatuses = new Set(["approved", "fulfilled"]);

export function buildAnalyticsSnapshot(input: SnapshotInput): AnalyticsSnapshot {
  const legacyOrders = input.missions.filter((mission) => mission.bundleId === null);
  const bundleStatusById = new Map(input.bundles.map((bundle) => [bundle.id, bundle.status]));
  const bookedLegacyOrders = legacyOrders.filter((mission) => mission.status !== "cancelled");
  const bookedBundles = input.bundles.filter((bundle) => bundle.status !== "cancelled");
  const orderRows = [
    ...legacyOrders.map((mission) => ({
      customerId: mission.customerId,
      status: mission.status,
      customerPriceCents: mission.customerPriceCents,
      scoutPayoutCents: mission.scoutPayoutCents,
      platformFeeCents: mission.platformFeeCents,
      bundleDiscountCents: mission.bundleDiscountCents,
      createdAt: mission.createdAt,
      completedAt: mission.completedAt,
    })),
    ...input.bundles,
  ];
  const bookedOrders = orderRows.filter((order) => order.status !== "cancelled");

  const customerOrderCounts = new Map<string, number>();
  for (const order of bookedOrders) {
    customerOrderCounts.set(order.customerId, (customerOrderCounts.get(order.customerId) ?? 0) + 1);
  }
  const repeatCustomers = [...customerOrderCounts.values()].filter((count) => count > 1).length;

  const rootBundleMissions = input.missions.filter((mission) => mission.bundleId && mission.bundleSequence === 1);
  const claimDurations = [...legacyOrders, ...rootBundleMissions]
    .filter((mission) => mission.claimedAt)
    .map((mission) => minutesBetween(mission.createdAt, mission.claimedAt as Date));
  const completionDurations = orderRows
    .filter((order) => order.status === "completed" && order.completedAt)
    .map((order) => hoursBetween(order.createdAt, order.completedAt as Date));

  const includedLegs = input.missions.filter((mission) => {
    if (!mission.bundleId) return mission.status !== "cancelled";
    return bundleStatusById.get(mission.bundleId) !== "cancelled";
  });
  const mixTotal = includedLegs.length;
  const missionMix = (["see", "move", "meet"] as const).map((type) => {
    const count = includedLegs.filter((mission) => mission.type === type).length;
    return { type, count, percent: mixTotal ? Math.round((count / mixTotal) * 100) : 0 };
  });

  const preferredMissions = includedLegs.filter((mission) =>
    mission.preferredScoutId && (mission.bundleId === null || mission.bundleSequence === 1)
  );
  const extensionRows = input.changeOrders;
  const acceptedExtensions = extensionRows.filter((order) => acceptedChangeOrderStatuses.has(order.status));

  const bookedValueCents = sum(bookedLegacyOrders, (order) => order.customerPriceCents)
    + sum(bookedBundles, (order) => order.customerPriceCents);
  const projectedScoutPayoutCents = sum(bookedLegacyOrders, (order) => order.scoutPayoutCents)
    + sum(bookedBundles, (order) => order.scoutPayoutCents);
  const projectedPlatformFeeCents = sum(bookedLegacyOrders, (order) => order.platformFeeCents)
    + sum(bookedBundles, (order) => order.platformFeeCents);

  return {
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    financial: {
      bookedValueCents,
      collectedRevenueCents: sum(input.payments.filter((payment) => payment.status === "paid"), (payment) => payment.amountCents),
      projectedScoutPayoutCents,
      projectedPlatformFeeCents,
      bundleDiscountCents: sum(bookedOrders, (order) => order.bundleDiscountCents),
    },
    operations: {
      totalOrders: orderRows.length,
      activeOrders: orderRows.filter((order) => !finalStatuses.has(order.status)).length,
      completedOrders: orderRows.filter((order) => order.status === "completed").length,
      cancelledOrders: orderRows.filter((order) => order.status === "cancelled").length,
      orderingCustomers: customerOrderCounts.size,
      repeatCustomers,
      repeatCustomerRate: customerOrderCounts.size ? repeatCustomers / customerOrderCounts.size : 0,
      averageOrderCents: bookedOrders.length ? Math.round(bookedValueCents / bookedOrders.length) : 0,
      averageMinutesToClaim: average(claimDurations),
      claimSampleSize: claimDurations.length,
      averageHoursToComplete: average(completionDurations),
      completionSampleSize: completionDurations.length,
    },
    missionMix,
    features: {
      activeTemplates: input.activeTemplates,
      activeRecurrences: input.recurrences.filter((recurrence) => recurrence.status === "active").length,
      totalRecurrences: input.recurrences.length,
      extensionRequests: extensionRows.length,
      acceptedExtensions: acceptedExtensions.length,
      extensionValueCents: sum(acceptedExtensions, (order) => order.customerDeltaCents),
      preferredOffers: preferredMissions.length,
      preferredConversions: preferredMissions.filter((mission) => mission.scoutId === mission.preferredScoutId).length,
      multipartBundles: input.bundles.length,
      enhancedReports: includedLegs.filter((mission) => mission.enhancedReportRequested).length,
      proofOfDeliveryMissions: includedLegs.filter((mission) => mission.proofOfDeliveryRequired).length,
      pinProtectedMissions: includedLegs.filter((mission) => mission.deliveryPinRequired).length,
      businessAccounts: input.businessAccounts,
    },
  };
}

function sum<T>(rows: T[], value: (row: T) => number) {
  return rows.reduce((total, row) => total + value(row), 0);
}

function average(values: number[]) {
  if (!values.length) return null;
  return Math.round((values.reduce((total, value) => total + value, 0) / values.length) * 10) / 10;
}

function minutesBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

function hoursBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / 3_600_000);
}
