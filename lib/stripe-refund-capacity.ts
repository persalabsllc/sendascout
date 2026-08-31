import "server-only";

import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions, payments } from "@/db/schema";

export async function getMissionRefundCapacity(missionId: string) {
  const db = getDb();
  const [mission] = await db.select({ id: missions.id, bundleId: missions.bundleId })
    .from(missions)
    .where(eq(missions.id, missionId))
    .limit(1);
  if (!mission) throw new Error("Mission not found for refund capacity.");
  const missionIds = mission.bundleId
    ? (await db.select({ id: missions.id }).from(missions).where(eq(missions.bundleId, mission.bundleId))).map((row) => row.id)
    : [mission.id];
  const [totals] = await db.select({
    capturedCents: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)::integer`,
    unlinkedMissionCaseReservationCents: sql<number>`COALESCE(SUM(COALESCE((
      SELECT SUM(unlinked_case_refund.amount_cents)::integer
      FROM payment_refunds AS unlinked_case_refund
      WHERE unlinked_case_refund.payment_id = ${payments.id}
        AND unlinked_case_refund.mission_case_id IS NULL
        AND unlinked_case_refund.status IN ('pending', 'requires_action')
        AND unlinked_case_refund.reason LIKE 'mission-case:%'
    ), 0)), 0)::integer`,
    refundableCents: sql<number>`COALESCE(SUM(GREATEST(
      0,
      ${payments.amountCents} - (
        GREATEST(
          ${payments.refundedAmountCents},
          COALESCE((
            SELECT SUM(succeeded_refund.amount_cents)::integer
            FROM payment_refunds AS succeeded_refund
            WHERE succeeded_refund.payment_id = ${payments.id}
              AND succeeded_refund.status = 'succeeded'
          ), 0)
        )
        + COALESCE((
          SELECT SUM(reserved_refund.amount_cents)::integer
          FROM payment_refunds AS reserved_refund
          WHERE reserved_refund.payment_id = ${payments.id}
            AND reserved_refund.status IN ('pending', 'requires_action')
        ), 0)
      )
    )), 0)::integer`,
  }).from(payments).where(sql`
    ${payments.missionId} IN (${sql.join(missionIds.map((id) => sql`${id}::uuid`), sql`, `)})
    AND ${payments.kind} NOT IN ('tip', 'duplicate')
    AND ${payments.stripeChargeId} IS NOT NULL
    AND ${payments.status} IN ('paid', 'partially_refunded', 'refunded', 'disputed')
  `);
  return {
    missionIds,
    capturedCents: Math.max(0, Number(totals?.capturedCents ?? 0)),
    refundableCents: Math.max(0, Number(totals?.refundableCents ?? 0)),
    unlinkedMissionCaseReservationCents: Math.max(0, Number(totals?.unlinkedMissionCaseReservationCents ?? 0)),
  };
}
