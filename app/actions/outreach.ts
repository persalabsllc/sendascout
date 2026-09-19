"use server";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminUser } from "@/lib/app-user";
import { parseProspectCsv, prospectInput, tailoredDraft, type Segment } from "@/lib/outreach-content";
import { googleOutreachConfigured } from "@/lib/outreach-google";
import { runOutreachWorker } from "@/lib/outreach-worker";
export type OutreachActionState={ok?:boolean;message?:string;href?:string};
const uuid=(v:FormDataEntryValue|null)=>{const s=String(v??"");if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s))throw new Error("Invalid record.");return s;};
const value=(f:FormData,key:string,max=4000)=>String(f.get(key)??"").trim().slice(0,max);
async function perform(operation:(adminId:string)=>Promise<OutreachActionState>):Promise<OutreachActionState> {
  try{const admin=await requireAdminUser();const result=await operation(admin.id);revalidatePath("/control-room/outreach","layout");return {ok:true,...result};}
  catch(error){unstable_rethrow(error);const code=typeof error==="object"&&error&&"code" in error?String(error.code):"";return {ok:false,message:code==="23505"?"This email or queued message already exists. Open the existing record.":code?"Could not save the record. Please try again.":error instanceof Error?error.message:"Could not complete this action."};}
}
export async function createOutreachProspect(_previous:OutreachActionState,form:FormData) {
  return perform(async adminId=>{const p=prospectInput(Object.fromEntries([...form.entries()].map(([k,v])=>[k,String(v)])));
    const result=await getDb().execute<{id:string}>(sql`INSERT INTO outreach_prospects(company,contact_name,email,website,segment,location,research_note,source_url,notes,permission,permission_note,permission_recorded_at,created_by,updated_by)
      VALUES(${p.company},${p.contactName},${p.email},${p.website},${p.segment},${p.location},${p.researchNote},${p.sourceUrl},${p.notes},${p.permission},${p.permissionNote},${p.permission==="research_only"?null:new Date().toISOString()}::timestamptz,${adminId}::uuid,${adminId}::uuid) RETURNING id`);
    return {message:"Prospect saved. No email has been sent.",href:`/control-room/outreach/${result.rows[0].id}`};});
}
export async function importOutreachProspects(_previous:OutreachActionState,form:FormData) {
  return perform(async adminId=>{const rows=parseProspectCsv(value(form,"csv",200001));if(!rows.length)throw new Error("Add at least one CSV row.");
    const result=await getDb().execute(sql`INSERT INTO outreach_prospects(company,contact_name,email,website,segment,location,research_note,source_url,notes,created_by,updated_by)
      SELECT x.company,x."contactName",x.email,x.website,x.segment,x.location,x."researchNote",x."sourceUrl",x.notes,${adminId}::uuid,${adminId}::uuid FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(company text,"contactName" text,email text,website text,segment text,location text,"researchNote" text,"sourceUrl" text,notes text) ON CONFLICT(email) DO NOTHING RETURNING id`);
    return {message:`${result.rows.length} prospects imported; ${rows.length-result.rows.length} existing records skipped. Imported contacts are research-only.`};});
}
export async function updateOutreachProspect(_previous:OutreachActionState,form:FormData) {
  return perform(async adminId=>{const id=uuid(form.get("id")),stage=value(form,"stage",30),permission=value(form,"permission",30),note=value(form,"permissionNote",1000),linked=value(form,"linkedCustomerId",40);
    if(!["new","contacted","replied","interested","customer","closed","unsubscribed"].includes(stage))throw new Error("Choose a pipeline stage.");
    if(!["research_only","requested","opt_in"].includes(permission)||permission!=="research_only"&&note.length<10)throw new Error("Record the recipient's request or permission before enabling email.");
    if(linked){uuid(linked);const user=await getDb().execute(sql`SELECT id FROM users WHERE id=${linked}::uuid`);if(!user.rows.length)throw new Error("Customer account not found.");}
    const result=await getDb().execute(sql`WITH updated AS(UPDATE outreach_prospects SET stage=CASE WHEN suppressed_at IS NOT NULL THEN 'unsubscribed' ELSE ${stage} END,permission=${permission},permission_note=${note},permission_recorded_at=CASE WHEN ${permission}='research_only' THEN NULL ELSE now() END,
      research_note=${value(form,"researchNote",1500)},notes=${value(form,"notes")},linked_customer_id=${linked||null}::uuid,
      suppressed_at=CASE WHEN ${stage}='unsubscribed' THEN COALESCE(suppressed_at,now()) ELSE suppressed_at END,
      suppression_reason=CASE WHEN ${stage}='unsubscribed' THEN 'Suppressed by administrator' ELSE suppression_reason END,updated_by=${adminId}::uuid,updated_at=now() WHERE id=${id}::uuid RETURNING id)
      UPDATE outreach_messages SET status='cancelled',error='Prospect changed; review a fresh draft',updated_at=now() WHERE prospect_id IN(SELECT id FROM updated) AND status='queued' RETURNING id`);
    return {message:`Prospect updated. ${result.rows.length} queued messages cancelled for review. Unsubscribed contacts stay suppressed.`};});
}
export async function generateOutreachDraft(_previous:OutreachActionState,form:FormData) {
  return perform(async()=>{const id=uuid(form.get("id")),parentId=value(form,"parentId",40);
    const row=await getDb().execute<{company:string;contact_name:string;segment:Segment;research_note:string;suppressed_at:string|null}>(sql`SELECT company,contact_name,segment,research_note,suppressed_at FROM outreach_prospects WHERE id=${id}::uuid`);
    const p=row.rows[0];if(!p||p.suppressed_at)throw new Error("This prospect is unavailable or unsubscribed.");
    let parentSubject:string|undefined;
    if(parentId){uuid(parentId);const parent=await getDb().execute<{subject:string}>(sql`SELECT subject FROM outreach_messages WHERE id=${parentId}::uuid AND prospect_id=${id}::uuid AND status='accepted' AND reply_at IS NULL AND followup_of IS NULL`);if(!parent.rows.length)throw new Error("A follow-up requires an accepted initial email with no response.");parentSubject=parent.rows[0].subject;}
    const draft=tailoredDraft({company:p.company,contactName:p.contact_name,segment:p.segment,researchNote:p.research_note},!!parentId);const messageId=crypto.randomUUID();
    await getDb().execute(sql`INSERT INTO outreach_messages(id,prospect_id,subject,body,followup_of,wire_message_id) VALUES(${messageId}::uuid,${id}::uuid,${parentSubject||draft.subject},${draft.body},${parentId||null}::uuid,${`${messageId}@sendascout.com`})`);
    return {message:"Draft generated from your saved research and the selected service. Review and edit before approving."};});
}
export async function saveOutreachDraft(_previous:OutreachActionState,form:FormData) {
  return perform(async()=>{const id=uuid(form.get("messageId")),subject=value(form,"subject",201),body=value(form,"body",10001);
    if(!subject||subject.length>200||/[\r\n]/.test(subject)||body.length<30||body.length>10000)throw new Error("Add a subject up to 200 characters and a message of 30–10,000 characters.");
    const result=await getDb().execute(sql`UPDATE outreach_messages SET subject=${subject},body=${body},updated_at=now() WHERE id=${id}::uuid AND status='draft' RETURNING id`);
    if(!result.rows.length)throw new Error("Only drafts can be edited. Cancel a queued message first.");return {message:"Draft saved."};});
}
export async function queueOutreachMessage(_previous:OutreachActionState,form:FormData) {
  return perform(async adminId=>{const id=uuid(form.get("messageId"));if(!googleOutreachConfigured())throw new Error("Complete Google Workspace setup before queueing email.");
    if(form.get("reviewed")!=="yes")throw new Error("Confirm you reviewed the message and contact permission.");
    const result=await getDb().execute(sql`UPDATE outreach_messages m SET status='queued',approved_by=${adminId}::uuid,approved_at=now(),scheduled_at=CASE WHEN followup_of IS NULL THEN now() ELSE GREATEST(now(),(SELECT accepted_at+interval '3 days' FROM outreach_messages parent WHERE parent.id=m.followup_of)) END,updated_at=now()
      FROM outreach_prospects p,outreach_settings s WHERE m.id=${id}::uuid AND m.prospect_id=p.id AND m.status='draft' AND length(m.body)>=30
      AND s.id=1 AND s.refresh_token_encrypted IS NOT NULL AND length(trim(s.postal_address))>=10
      AND p.suppressed_at IS NULL AND p.permission IN ('requested','opt_in') AND length(trim(p.permission_note))>=10 AND p.stage IN ('new','contacted')
      AND (m.followup_of IS NULL OR EXISTS(SELECT 1 FROM outreach_messages parent WHERE parent.id=m.followup_of AND parent.status='accepted' AND parent.reply_at IS NULL)) RETURNING m.id`);
    if(!result.rows.length)throw new Error("Check mailbox connection, postal address, prospect permission, and draft status. Responded or converted prospects cannot be queued.");
    return {message:"Approved and queued. Sending must be enabled in settings. Follow-ups wait at least three days."};});
}
export async function cancelOutreachMessage(_previous:OutreachActionState,form:FormData) {
  return perform(async()=>{const id=uuid(form.get("messageId"));await getDb().execute(sql`UPDATE outreach_messages SET status='cancelled',error='Cancelled by administrator',updated_at=now() WHERE id=${id}::uuid AND status IN ('draft','queued')`);return {message:"Draft or queued message cancelled. A send already in progress cannot be recalled."};});
}
export async function saveOutreachSettings(_previous:OutreachActionState,form:FormData) {
  return perform(async()=>{const daily=Number(form.get("dailyLimit")),postal=value(form,"postalAddress",500),paused=form.get("enabled")!=="yes";
    if(!Number.isInteger(daily)||daily<1||daily>40)throw new Error("Choose 1–40 emails per weekday.");
    if(!paused&&(!googleOutreachConfigured()||postal.length<10))throw new Error("Connect Google and add your business postal address before enabling sends.");
    const result=await getDb().execute(sql`UPDATE outreach_settings SET daily_limit=${daily},postal_address=${postal},paused=${paused},updated_at=now() WHERE id=1 AND (${paused} OR refresh_token_encrypted IS NOT NULL) RETURNING id`);
    if(!result.rows.length)throw new Error("Connect the mailbox first.");return {message:paused?"Sending paused. Drafts and reply checks remain available.":"Approved emails will send on weekdays, 9 AM–5 PM Eastern, within your daily limit."};});
}
export async function syncOutreachMailbox() {
  return perform(async()=>{const result=await runOutreachWorker({send:false});return {message:"error" in result?"Google check failed; sending is paused. Review connection status.":"skipped" in result&&result.skipped==="google_setup_required"?"Google Workspace setup is required.":"Mailbox and purchase checks finished. Refresh to see current statuses."};});
}
export async function disconnectOutreachMailbox() {
  return perform(async()=>{const result=await getDb().execute(sql`UPDATE outreach_settings SET paused=true,mailbox=NULL,refresh_token_encrypted=NULL,connected_at=NULL,last_error=NULL,updated_at=now() WHERE id=1 AND (lease_until IS NULL OR lease_until<now()) RETURNING id`);if(!result.rows.length)throw new Error("A mailbox check is running. Pause sending, then disconnect in a few minutes.");return {message:"Mailbox disconnected and sending paused. You can also revoke the app in your Google account."};});
}
