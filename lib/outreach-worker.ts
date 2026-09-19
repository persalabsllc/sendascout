import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { businessHours } from "@/lib/outreach-content";
import { outreachRawEmail } from "@/lib/outreach-mail";
import { gmailRequest, googleOutreachConfigured, outreachAccessToken } from "@/lib/outreach-google";
import { claimOutreachMessage, reconcileOutreachCustomers } from "@/lib/outreach-sql";

type Settings={paused:boolean;mailbox:string|null;refresh_token_encrypted:string|null;postal_address:string};
type Message={id:string;prospect_id:string;google_thread_id:string|null;sender_mailbox:string|null;attempted_at:string;status:string;wire_message_id:string};
type Thread={messages?:{id:string;internalDate:string;labelIds?:string[];payload?:{headers?:{name:string;value:string}[]}}[]};
export async function checkOutreachReply(access:string,message:Message) {
  if(!message.google_thread_id)return;
  const data=await gmailRequest<Thread>(access,`/threads/${encodeURIComponent(message.google_thread_id)}?format=metadata&metadataHeaders=From&metadataHeaders=Auto-Submitted`);
  if(!data.messages?.length)throw new Error("Google did not return the conversation. Sending paused.");
  const reply=data.messages.find(m=>Number(m.internalDate)>=new Date(message.attempted_at).getTime()&&!m.labelIds?.includes("SENT")&&!m.labelIds?.includes("DRAFT"));
  const db=getDb();
  if(reply) {
    await db.execute(sql`WITH stopped AS (UPDATE outreach_prospects SET stage=CASE WHEN stage IN ('new','contacted') THEN 'replied' ELSE stage END,updated_at=now() WHERE id=${message.prospect_id}::uuid RETURNING id), replied AS (UPDATE outreach_messages SET status='replied',reply_at=now(),last_checked_at=now(),updated_at=now() WHERE id=${message.id}::uuid RETURNING id)
      UPDATE outreach_messages SET status='cancelled',error='A response arrived; review the conversation in Gmail',updated_at=now() WHERE prospect_id IN (SELECT id FROM stopped) AND status='queued'`);
  } else await db.execute(sql`UPDATE outreach_messages SET last_checked_at=now() WHERE id=${message.id}::uuid`);
}
export async function runOutreachWorker(options:{send?:boolean}={}) {
  if(process.env.VERCEL_ENV!=="production")return {skipped:"not_production"};
  const db=getDb();await db.execute(reconcileOutreachCustomers());
  if(!googleOutreachConfigured())return {skipped:"google_setup_required"};
  const lease=crypto.randomUUID();
  const lock=await db.execute<Settings>(sql`UPDATE outreach_settings SET lease_token=${lease}::uuid,lease_until=now()+interval '6 minutes' WHERE id=1 AND refresh_token_encrypted IS NOT NULL AND (lease_until IS NULL OR lease_until<now()) RETURNING paused,mailbox,refresh_token_encrypted,postal_address`);
  const settings=lock.rows[0];if(!settings?.mailbox||!settings.refresh_token_encrypted)return {skipped:"not_connected_or_busy"};
  try {
    const access=await outreachAccessToken(settings.refresh_token_encrypted);
    // Gmail has no send idempotency key. Never blindly retry an uncertain send.
    await db.execute(sql`UPDATE outreach_messages SET status='unknown',error='Delivery outcome uncertain. Checking Gmail; automatic resend is disabled.' WHERE status='sending' AND attempted_at<now()-interval '4 minutes'`);
    const uncertain=await db.execute<Message>(sql`SELECT * FROM outreach_messages WHERE status='unknown' AND sender_mailbox=${settings.mailbox} ORDER BY last_checked_at ASC NULLS FIRST LIMIT 3`);
    for(const message of uncertain.rows) {
      const match=await gmailRequest<{messages?:{id:string;threadId:string}[]}>(access,`/messages?q=${encodeURIComponent(`in:sent rfc822msgid:${message.wire_message_id}`)}&maxResults=2`);
      if(match.messages?.length===1)await db.execute(sql`UPDATE outreach_messages SET status='accepted',google_message_id=${match.messages[0].id},google_thread_id=${match.messages[0].threadId},accepted_at=COALESCE(accepted_at,attempted_at),last_checked_at=now(),error=NULL WHERE id=${message.id}::uuid AND status='unknown'`);
      else await db.execute(sql`UPDATE outreach_messages SET last_checked_at=now() WHERE id=${message.id}::uuid`);
    }
    const threads=await db.execute<Message>(sql`SELECT * FROM outreach_messages WHERE status='accepted' AND google_thread_id IS NOT NULL AND sender_mailbox=${settings.mailbox} ORDER BY last_checked_at ASC NULLS FIRST LIMIT 10`);
    for(const message of threads.rows)await checkOutreachReply(access,message);
    await db.execute(sql`UPDATE outreach_settings SET last_sync_at=now(),last_error=NULL WHERE id=1`);
    if(options.send===false||settings.paused||!businessHours())return {synced:threads.rows.length,skipped:settings.paused?"paused":"not_sending_now"};
    await db.execute(sql`UPDATE outreach_messages AS m SET status='cancelled',error='Prospect is no longer eligible for automated contact',updated_at=now() FROM outreach_prospects AS p WHERE m.prospect_id=p.id AND m.status='queued' AND (p.suppressed_at IS NOT NULL OR p.permission='research_only' OR p.stage NOT IN ('new','contacted') OR (m.followup_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM outreach_messages parent WHERE parent.id=m.followup_of AND parent.status='accepted' AND parent.reply_at IS NULL)))`);
    const candidate=await db.execute<Message&{subject:string;body:string;email:string;unsubscribe_token:string;followup_of:string|null}>(sql`SELECT m.*,p.email,p.unsubscribe_token FROM outreach_messages m JOIN outreach_prospects p ON p.id=m.prospect_id WHERE m.status='queued' AND m.scheduled_at<=now() ORDER BY m.scheduled_at LIMIT 1`);
    const message=candidate.rows[0];if(!message)return {synced:threads.rows.length,sent:0};
    let parent:Message|undefined;
    if(message.followup_of){parent=(await db.execute<Message>(sql`SELECT * FROM outreach_messages WHERE id=${message.followup_of}::uuid`)).rows[0];if(parent)await checkOutreachReply(access,parent);}
    const raw=outreachRawEmail({from:settings.mailbox,to:message.email,subject:message.subject,body:message.body,id:message.wire_message_id,unsubscribeToken:message.unsubscribe_token,postalAddress:settings.postal_address,inReplyTo:parent?.wire_message_id});
    const claimed=await db.execute(claimOutreachMessage(message.id,raw,settings.mailbox,lease));if(!claimed.rows.length)return {synced:threads.rows.length,sent:0};
    try {
      const result=await gmailRequest<{id:string;threadId:string}>(access,"/messages/send",{raw,...(parent?.google_thread_id?{threadId:parent.google_thread_id}:{})});
      if(!result.id||!result.threadId)throw new Error("Google did not confirm acceptance.");
      await db.execute(sql`WITH accepted AS(UPDATE outreach_messages SET status='accepted',google_message_id=${result.id},google_thread_id=${result.threadId},accepted_at=now(),error=NULL,updated_at=now() WHERE id=${message.id}::uuid RETURNING prospect_id) UPDATE outreach_prospects SET stage='contacted',updated_at=now() WHERE id IN(SELECT prospect_id FROM accepted) AND stage='new' AND suppressed_at IS NULL`);
      console.info("Outreach email accepted by Google",{messageId:message.id});return {synced:threads.rows.length,sent:1};
    } catch {
      await db.execute(sql`UPDATE outreach_messages SET status='unknown',error='Google acceptance was not confirmed. Checking Sent mail before any further action.',updated_at=now() WHERE id=${message.id}::uuid AND status='sending'`);
      await db.execute(sql`UPDATE outreach_settings SET paused=true,last_error='An email has an uncertain delivery outcome. Review it before resuming.' WHERE id=1`);
      return {sent:0,unknown:1};
    }
  } catch {
    await db.execute(sql`UPDATE outreach_settings SET paused=true,last_error='Google connection or reply check failed. Sending is paused; reconnect or retry sync.' WHERE id=1`);
    console.error("Outreach worker paused after a connection or reply-check failure");return {error:"Sending paused"};
  } finally {await db.execute(sql`UPDATE outreach_settings SET lease_until=NULL,lease_token=NULL WHERE id=1 AND lease_token=${lease}::uuid`);}
}
