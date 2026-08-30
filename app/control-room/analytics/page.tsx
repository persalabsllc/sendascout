import { isNull } from "drizzle-orm";
import { ControlRoomAnalytics } from "@/components/control-room-analytics";
import { getDb } from "@/db";
import {
  businessAccounts,
  missionBundles,
  missionChangeOrders,
  missionRecurrences,
  missions,
  missionTemplates,
  payments,
} from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";
import { buildAnalyticsSnapshot } from "./metrics";

export const metadata = { title: "Marketplace Analytics | Send a Scout", robots: { index: false, follow: false } };

export default async function ControlRoomAnalyticsPage() {
  await requireAdminUser();
  const db = getDb();
  const [missionRows, bundleRows, paymentRows, changeOrderRows, templateRows, recurrenceRows, businessRows] = await Promise.all([
    db.select({
      customerId: missions.customerId,
      scoutId: missions.scoutId,
      bundleId: missions.bundleId,
      bundleSequence: missions.bundleSequence,
      type: missions.type,
      status: missions.status,
      customerPriceCents: missions.customerPriceCents,
      scoutPayoutCents: missions.scoutPayoutCents,
      platformFeeCents: missions.platformFeeCents,
      bundleDiscountCents: missions.bundleDiscountCents,
      preferredScoutId: missions.preferredScoutId,
      enhancedReportRequested: missions.enhancedReportRequested,
      proofOfDeliveryRequired: missions.proofOfDeliveryRequired,
      deliveryPinRequired: missions.deliveryPinRequired,
      claimedAt: missions.claimedAt,
      completedAt: missions.completedAt,
      createdAt: missions.createdAt,
    }).from(missions).where(isNull(missions.archivedAt)),
    db.select({
      id: missionBundles.id,
      customerId: missionBundles.customerId,
      status: missionBundles.status,
      customerPriceCents: missionBundles.customerPriceCents,
      scoutPayoutCents: missionBundles.scoutPayoutCents,
      platformFeeCents: missionBundles.platformFeeCents,
      bundleDiscountCents: missionBundles.bundleDiscountCents,
      completedAt: missionBundles.completedAt,
      createdAt: missionBundles.createdAt,
    }).from(missionBundles),
    db.select({ status: payments.status, amountCents: payments.amountCents }).from(payments),
    db.select({
      kind: missionChangeOrders.kind,
      status: missionChangeOrders.status,
      customerDeltaCents: missionChangeOrders.customerDeltaCents,
    }).from(missionChangeOrders),
    db.select({ id: missionTemplates.id }).from(missionTemplates).where(isNull(missionTemplates.archivedAt)),
    db.select({ status: missionRecurrences.status }).from(missionRecurrences),
    db.select({ id: businessAccounts.id }).from(businessAccounts),
  ]);

  const snapshot = buildAnalyticsSnapshot({
    missions: missionRows,
    bundles: bundleRows,
    payments: paymentRows,
    changeOrders: changeOrderRows,
    activeTemplates: templateRows.length,
    recurrences: recurrenceRows,
    businessAccounts: businessRows.length,
  });

  return <ControlRoomAnalytics snapshot={snapshot} />;
}
