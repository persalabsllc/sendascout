import { sql } from "drizzle-orm";
/** Financial offer mutation: the mission, paid allocation and audit move together. */
export function seeBoostSql(input:{id:string;current:number;version:number;target:number;livemode:boolean}) {
 return sql`WITH locked_mission AS MATERIALIZED (
  SELECT * FROM missions WHERE id=${input.id} AND type='see' AND see_template_key IS NOT NULL AND bundle_id IS NULL
    AND status='open' AND payment_status='paid' AND scout_id IS NULL AND archived_at IS NULL
    AND see_assignment_cutoff_at>now() AND see_boost_paused=false AND see_accepted_payout_cents IS NULL
    AND scout_payout_cents=${input.current} AND see_offer_version=${input.version}
    AND ${input.target}>scout_payout_cents AND ${input.target}<=see_payout_cap_cents AND ${input.target}<=customer_price_cents
    AND NOT EXISTS(SELECT 1 FROM mission_cases WHERE mission_id=${input.id} AND status='open') FOR UPDATE
 ), funding AS MATERIALIZED (
  SELECT p.* FROM payments p JOIN locked_mission m ON m.id=p.mission_id
  WHERE p.kind='booking' AND p.status='paid' AND p.livemode=${input.livemode} AND p.stripe_charge_id IS NOT NULL
    AND p.amount_cents=m.customer_price_cents AND p.scout_payout_cents=m.scout_payout_cents AND p.platform_fee_cents=m.platform_fee_cents
    AND p.refunded_amount_cents=0
    AND NOT EXISTS(SELECT 1 FROM payment_refunds r WHERE r.payment_id=p.id AND r.status<>'canceled')
    AND NOT EXISTS(SELECT 1 FROM payment_disputes d WHERE d.payment_id=p.id AND d.status NOT IN ('won','prevented','warning_closed'))
    AND NOT EXISTS(SELECT 1 FROM payment_transfers t WHERE t.payment_id=p.id)
  FOR UPDATE OF p
 ), adjusted_payment AS (
  UPDATE payments p SET scout_payout_cents=${input.target},platform_fee_cents=p.amount_cents-${input.target},updated_at=now()
  FROM funding WHERE p.id=funding.id AND (SELECT count(*) FROM funding)=1 RETURNING p.id
 ), adjusted_mission AS (
  UPDATE missions m SET scout_payout_cents=${input.target},platform_fee_cents=m.customer_price_cents-${input.target},see_offer_version=m.see_offer_version+1,alert_generation=m.alert_generation+1,updated_at=now()
  FROM locked_mission WHERE m.id=locked_mission.id AND EXISTS(SELECT 1 FROM adjusted_payment)
  RETURNING m.id,m.see_offer_version
 ), audit AS (
  INSERT INTO see_offer_events (mission_id,version,previous_cents,offered_cents,reason)
  SELECT id,see_offer_version,${input.current},${input.target},'Automatic deadline-based offer increase; customer price unchanged.' FROM adjusted_mission RETURNING id
 ), timeline AS (
  INSERT INTO mission_updates (mission_id,status,message) SELECT id,'open'::mission_status,'Scout offer increased automatically within the mission budget.' FROM adjusted_mission RETURNING id
 ) SELECT id,1 / CASE WHEN (SELECT count(*) FROM audit)=1 AND (SELECT count(*) FROM adjusted_payment)=1 THEN 1 ELSE 0 END AS invariant FROM adjusted_mission`;
}
export function seeExpirySql(id:string) {
 return sql`WITH expired AS (
  UPDATE missions SET status='cancelled',see_expired_at=now(),updated_at=now()
  WHERE id=${id} AND see_template_key IS NOT NULL AND status='open' AND scout_id IS NULL AND archived_at IS NULL AND payment_status='paid' AND see_assignment_cutoff_at<=now()
  RETURNING id
 ), timeline AS (INSERT INTO mission_updates (mission_id,status,message) SELECT id,'cancelled'::mission_status,'No Scout was assigned by the cutoff. Full refund processing has been queued.' FROM expired RETURNING id)
 SELECT id FROM expired`;
}
