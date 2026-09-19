import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import type { Segment } from "@/lib/outreach-content";
export type OutreachProspect={id:string;company:string;contact_name:string;email:string;website:string;segment:Segment;location:string;research_note:string;source_url:string;notes:string;stage:string;permission:string;permission_note:string;suppressed_at:string|null;linked_customer_id:string|null;created_at:string;updated_at:string};
export type OutreachMessage={id:string;subject:string;body:string;status:string;followup_of:string|null;google_thread_id:string|null;sender_mailbox:string|null;accepted_at:string|null;scheduled_at:string|null;created_at:string;updated_at:string;error:string|null};
export async function outreachSettings() {
  return (await getDb().execute<{paused:boolean;daily_limit:number;postal_address:string;mailbox:string|null;connected:boolean;last_sync_at:string|null;last_error:string|null}>(sql`SELECT paused,daily_limit,postal_address,mailbox,refresh_token_encrypted IS NOT NULL AS connected,last_sync_at,last_error FROM outreach_settings WHERE id=1`)).rows[0];
}
export async function outreachProspects(search="",stage="") {
  return (await getDb().execute<OutreachProspect&{message_count:number}>(sql`SELECT p.*,(SELECT count(*)::int FROM outreach_messages m WHERE m.prospect_id=p.id) AS message_count FROM outreach_prospects p WHERE (${search}='' OR p.company ILIKE ${`%${search}%`} OR p.email ILIKE ${`%${search}%`}) AND (${stage}='' OR p.stage=${stage}) ORDER BY p.created_at DESC LIMIT 200`)).rows;
}
export async function outreachTotals() {
  return (await getDb().execute<{prospects:number;drafts:number;queued:number;accepted:number;responses:number;paid_customers:number;net_cents:number}>(sql`SELECT (SELECT count(*)::int FROM outreach_prospects) AS prospects,(SELECT count(*)::int FROM outreach_messages WHERE status='draft') AS drafts,(SELECT count(*)::int FROM outreach_messages WHERE status='queued') AS queued,(SELECT count(*)::int FROM outreach_messages WHERE google_message_id IS NOT NULL) AS accepted,(SELECT count(*)::int FROM outreach_prospects WHERE stage IN ('replied','interested')) AS responses,
    count(DISTINCT p.customer_id)::int AS paid_customers,COALESCE(sum(p.amount_cents-p.refunded_amount_cents),0)::int AS net_cents FROM payments p JOIN users u ON u.id=p.customer_id WHERE p.kind='booking' AND p.status IN ('paid','partially_refunded') AND p.amount_cents>p.refunded_amount_cents AND EXISTS(SELECT 1 FROM outreach_prospects prospect WHERE (prospect.email=lower(u.email) OR prospect.linked_customer_id=u.id) AND EXISTS(SELECT 1 FROM outreach_messages m WHERE m.prospect_id=prospect.id AND m.accepted_at<=p.paid_at))`)).rows[0];
}
export async function outreachProspectDetail(id:string) {
  const [prospect,messages,bookings]=await Promise.all([
    getDb().execute<OutreachProspect>(sql`SELECT * FROM outreach_prospects WHERE id=${id}::uuid`),
    getDb().execute<OutreachMessage>(sql`SELECT id,subject,body,status,followup_of,google_thread_id,sender_mailbox,accepted_at,scheduled_at,created_at,updated_at,error FROM outreach_messages WHERE prospect_id=${id}::uuid ORDER BY created_at DESC`),
    getDb().execute<{id:string;title:string;status:string;paid_at:string;net_cents:number;payout_cents:number}>(sql`SELECT m.id,m.title,m.status,p.paid_at,p.amount_cents-p.refunded_amount_cents AS net_cents,p.scout_payout_cents AS payout_cents FROM payments p JOIN missions m ON m.id=p.mission_id JOIN users u ON u.id=p.customer_id JOIN outreach_prospects prospect ON (prospect.email=lower(u.email) OR prospect.linked_customer_id=u.id) WHERE prospect.id=${id}::uuid AND p.kind='booking' AND p.status IN ('paid','partially_refunded') ORDER BY p.paid_at DESC LIMIT 30`),
  ]);
  return {prospect:prospect.rows[0],messages:messages.rows,bookings:bookings.rows};
}
