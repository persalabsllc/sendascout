import { sql } from "drizzle-orm";
export function claimOutreachMessage(id:string,raw:string,mailbox:string,lease:string) {
  return sql`UPDATE outreach_messages AS m SET status='sending',attempted_at=now(),raw_payload=${raw},sender_mailbox=${mailbox},updated_at=now()
    FROM outreach_prospects AS p, outreach_settings AS settings
    WHERE m.id=${id}::uuid AND m.prospect_id=p.id AND m.status='queued' AND m.scheduled_at<=now()
      AND m.approved_by IS NOT NULL AND p.suppressed_at IS NULL AND p.permission IN ('requested','opt_in')
      AND length(trim(p.permission_note))>=10 AND p.stage IN ('new','contacted')
      AND settings.id=1 AND settings.paused=false AND settings.mailbox=${mailbox}
      AND settings.lease_token=${lease}::uuid AND settings.lease_until>now()
      AND (SELECT count(*) FROM outreach_messages WHERE attempted_at >= date_trunc('day',now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')<settings.daily_limit
      AND NOT EXISTS(SELECT 1 FROM payments pay JOIN users u ON u.id=pay.customer_id WHERE (lower(u.email)=p.email OR u.id=p.linked_customer_id) AND pay.kind='booking' AND pay.status IN ('paid','partially_refunded') AND pay.amount_cents>pay.refunded_amount_cents)
      AND (m.followup_of IS NULL OR EXISTS(SELECT 1 FROM outreach_messages parent WHERE parent.id=m.followup_of AND parent.prospect_id=p.id AND parent.status='accepted' AND parent.reply_at IS NULL AND parent.last_checked_at>now()-interval '2 minutes'))
    RETURNING m.id`;
}
export function suppressOutreach(token:string) {
  return sql`WITH suppressed AS (UPDATE outreach_prospects SET stage='unsubscribed',suppressed_at=COALESCE(suppressed_at,now()),suppression_reason='Recipient unsubscribed',updated_at=now() WHERE unsubscribe_token=${token} RETURNING id)
    UPDATE outreach_messages SET status='cancelled',error='Recipient unsubscribed',updated_at=now() WHERE prospect_id IN(SELECT id FROM suppressed) AND status IN ('draft','queued')`;
}
export function reconcileOutreachCustomers() {
  return sql`WITH converted AS (UPDATE outreach_prospects p SET stage='customer',updated_at=now() WHERE p.suppressed_at IS NULL AND p.stage NOT IN ('customer','unsubscribed') AND EXISTS(SELECT 1 FROM payments pay JOIN users u ON u.id=pay.customer_id WHERE (lower(u.email)=p.email OR u.id=p.linked_customer_id) AND pay.kind='booking' AND pay.status IN ('paid','partially_refunded') AND pay.amount_cents>pay.refunded_amount_cents) RETURNING id)
    UPDATE outreach_messages SET status='cancelled',error='Prospect has a paid mission',updated_at=now() WHERE status='queued' AND prospect_id IN(SELECT id FROM converted)`;
}
