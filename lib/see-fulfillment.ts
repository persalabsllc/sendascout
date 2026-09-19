import "server-only";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { missions } from "@/db/schema";
import { seeOfferAt } from "@/lib/see-it";
import { seeBoostSql, seeExpirySql } from "@/lib/see-fulfillment-sql";
import { alertEligibleScouts, notifyUserOnce } from "@/lib/notifications";
import { requestMissionRefund } from "@/lib/stripe-refunds";
import { getStripeLivemode } from "@/lib/stripe";

export async function runSeeFulfillment() {
 const db=getDb();const now=new Date();const livemode=getStripeLivemode();
 const open=await db.select().from(missions).where(and(isNotNull(missions.seeTemplateKey),eq(missions.status,"open"),eq(missions.paymentStatus,"paid"),isNull(missions.scoutId),isNull(missions.archivedAt))).limit(200);
 let boosted=0,expired=0,refunds=0,errors=0;
 for(const mission of open){try{
  if(mission.seeAssignmentCutoffAt && mission.seeAssignmentCutoffAt<=now){const result=await db.execute(seeExpirySql(mission.id));expired+=result.rows.length;continue;}
  if(process.env.SEE_IT_BOOSTS_PAUSED==="true" || mission.seeBoostPaused || !mission.seeFundedAt || !mission.seeDeadlineAt || mission.seeBasePayoutCents===null || mission.seePayoutCapCents===null)continue;
  const target=seeOfferAt({baseCents:mission.seeBasePayoutCents,capCents:mission.seePayoutCapCents,currentCents:mission.scoutPayoutCents,fundedAt:mission.seeFundedAt,deadline:mission.seeDeadlineAt,now});
  if(target>mission.scoutPayoutCents){const result=await db.execute(seeBoostSql({id:mission.id,current:mission.scoutPayoutCents,version:mission.seeOfferVersion,target,livemode}));if(result.rows.length){boosted++;await alertEligibleScouts(mission.id);}}
 }catch(error){errors++;console.error("See It fulfillment stage failed",{missionId:mission.id,error});}}
 // Cancellation is the durable refund intent. A crashed worker resumes here with the same idempotency key.
 const expiredMissions=await db.select().from(missions).where(and(isNotNull(missions.seeExpiredAt),eq(missions.status,"cancelled"),sql`${missions.paymentStatus} IN ('paid','partially_refunded')`)).limit(100);
 for(const mission of expiredMissions){try{
  const result=await requestMissionRefund({missionId:mission.id,amountCents:mission.customerPriceCents,idempotencyKey:`see-expiry:${mission.id}:v1`,reason:"Unassigned See It mission reached its assignment cutoff."});
  if(result.refundRequestedCents===mission.customerPriceCents){refunds++;await notifyUserOnce({recipientUserId:mission.customerId,missionId:mission.id,kind:"see_unassigned_refund",dedupeScope:"cutoff",title:"We couldn’t assign your Scout in time",body:"Your mission was cancelled at its assignment cutoff and a full refund has been initiated. Your bank determines when the refund appears. You can view its status in your payment history.",actionLabel:"View payments",actionUrl:"https://www.sendascout.com/dashboard/customer/payments"});}
 }catch(error){errors++;console.error("See It expiry refund needs retry",{missionId:mission.id,error});}}
 return {checked:open.length,boosted,expired,refunds,errors};
}
