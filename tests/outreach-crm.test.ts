import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import * as orm from "drizzle-orm";
import { businessHours, normalizeEmail, parseProspectCsv, prospectInput, safeWebsite, tailoredDraft } from "../lib/outreach-content.ts";
import { decryptOutreachToken, encryptOutreachToken, outreachRawEmail } from "../lib/outreach-mail.ts";
import { claimOutreachMessage, reconcileOutreachCustomers, suppressOutreach } from "../lib/outreach-sql.ts";
const pg=new PGlite(),dialect=new PgDialect();const admin=crypto.randomUUID(),lease=crypto.randomUUID();
before(async()=>{for(const m of readMigrationFiles({migrationsFolder:"./db/migrations"}))for(const s of m.sql)await pg.exec(s);await pg.query("INSERT INTO users(id,clerk_user_id,email,role) VALUES($1,'crm-test','admin@example.test','admin')",[admin]);});
beforeEach(async()=>{await pg.exec("DELETE FROM outreach_messages; DELETE FROM outreach_prospects;");await pg.query("UPDATE outreach_settings SET paused=false,daily_limit=10,postal_address='Fixture business address',mailbox='support@sendascout.com',refresh_token_encrypted='fixture',lease_token=$1,lease_until=now()+interval '6 minutes',last_error=NULL",[lease]);});
after(()=>pg.close());
async function execute(query:Parameters<typeof dialect.sqlToQuery>[0]) {const q=dialect.sqlToQuery(query);return pg.query(q.sql,q.params);}
async function seed(permission="opt_in") {
  const prospectId=crypto.randomUUID(),id=crypto.randomUUID(),email=`${prospectId}@example.test`;
  await pg.query("INSERT INTO outreach_prospects(id,company,email,segment,permission,permission_note,created_by,updated_by) VALUES($1,'Fixture company',$2,'property',$3,'Requested details on a phone call',$4,$4)",[prospectId,email,permission,admin]);
  await pg.query("INSERT INTO outreach_messages(id,prospect_id,subject,body,status,approved_by,approved_at,scheduled_at,wire_message_id) VALUES($1,$2,'Example subject','Example message with enough content to send','queued',$3,now(),now(),$4)",[id,prospectId,admin,`${id}@sendascout.com`]);return {id,prospectId,email};
}
async function claim(id:string) {return execute(claimOutreachMessage(id,"raw-fixture","support@sendascout.com",lease));}
async function state(id:string) {return (await pg.query<{status:string;google_message_id:string|null}>("SELECT * FROM outreach_messages WHERE id=$1",[id])).rows[0];}
test("CSV handles quotes and newlines, normalizes duplicates, and never imports sending permission",()=>{
  const rows=parseProspectCsv('company,email,segment,researchNote,permission\n"Example, Inc",HELLO@example.test,property,"Line one\nLine two",opt_in');
  assert.equal(rows[0].company,"Example, Inc");assert.equal(rows[0].email,"hello@example.test");assert.equal(rows[0].researchNote,"Line one\nLine two");assert.equal(rows[0].permission,"research_only");
  assert.throws(()=>parseProspectCsv("company,email\nOne,a@example.test\nTwo,A@example.test"),/Duplicate/);
  assert.throws(()=>parseProspectCsv('company,email\n"unfinished'),/unfinished/);
  assert.throws(()=>safeWebsite("javascript:alert(1)"));assert.throws(()=>normalizeEmail("a@example.test\r\nBcc: b@example.test"));
  assert.throws(()=>prospectInput({company:"A",email:"a@example.test",segment:"property",permission:"opt_in"}),/Record/);
  assert.throws(()=>prospectInput({company:"A",email:"a@example.test",segment:"toString"}),/business type/);
});
test("drafts use recorded research and accurate service boundaries; time window respects Eastern weekends",()=>{
  const p={company:"Example",contactName:"Jordan",segment:"vehicle" as const,researchNote:"You mentioned you buy vehicles remotely."};const draft=tailoredDraft(p);
  assert.match(draft.body,/You mentioned/);assert.match(draft.body,/\$49/);assert.match(draft.body,/not a mechanical inspection/);assert.match(draft.body,/72 hours/);
  assert.equal(businessHours(new Date("2026-09-21T13:00:00Z")),true);assert.equal(businessHours(new Date("2026-09-21T21:00:00Z")),false);assert.equal(businessHours(new Date("2026-09-19T15:00:00Z")),false);
});
test("refresh token encryption authenticates ciphertext and mail headers reject injection",()=>{
  const key="ab".repeat(32),encrypted=encryptOutreachToken("private-refresh-token",key);assert.equal(decryptOutreachToken(encrypted,key),"private-refresh-token");assert.ok(!encrypted.includes("private-refresh"));assert.throws(()=>decryptOutreachToken(encrypted,"cd".repeat(32)));
  const input={from:"support@sendascout.com",to:"a@example.test",subject:"Hello",body:"Example body",id:`${crypto.randomUUID()}@sendascout.com`,unsubscribeToken:"ab".repeat(32),postalAddress:"123 Fixture address"};
  const raw=Buffer.from(outreachRawEmail(input),"base64url").toString();assert.match(raw,/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);assert.match(raw,/Message-ID:/);assert.throws(()=>outreachRawEmail({...input,subject:"Hello\r\nBcc: stolen@example.test"}));
});
test("claim is exclusive and requires permission, approved state, active lease and unpaused controls",async()=>{
  const p=await seed("research_only");assert.equal((await claim(p.id)).rows.length,0);
  await pg.query("UPDATE outreach_prospects SET permission='opt_in' WHERE id=$1",[p.prospectId]);
  await pg.exec("UPDATE outreach_settings SET paused=true");assert.equal((await claim(p.id)).rows.length,0);
  await pg.exec("UPDATE outreach_settings SET paused=false,lease_until=now()-interval '1 minute'");assert.equal((await claim(p.id)).rows.length,0);
  await pg.exec("UPDATE outreach_settings SET lease_until=now()+interval '6 minutes'");
  const result=await Promise.all([claim(p.id),claim(p.id)]);assert.equal(result[0].rows.length+result[1].rows.length,1);assert.equal((await state(p.id)).status,"sending");
});
test("daily attempt cap counts uncertain sends and queue cannot bypass suppression",async()=>{
  await pg.exec("UPDATE outreach_settings SET daily_limit=1");const a=await seed(),b=await seed();assert.equal((await claim(a.id)).rows.length,1);assert.equal((await claim(b.id)).rows.length,0);
  await pg.query("UPDATE outreach_messages SET status='unknown' WHERE id=$1",[a.id]);assert.equal((await claim(b.id)).rows.length,0);
  const token=(await pg.query<{unsubscribe_token:string}>("SELECT unsubscribe_token FROM outreach_prospects WHERE id=$1",[b.prospectId])).rows[0].unsubscribe_token;
  await execute(suppressOutreach(token));assert.equal((await state(b.id)).status,"cancelled");
  await pg.query("UPDATE outreach_messages SET status='queued' WHERE id=$1",[b.id]);await pg.exec("UPDATE outreach_settings SET daily_limit=40");assert.equal((await claim(b.id)).rows.length,0);
});
test("follow-ups require a fresh no-response check and only one follow-up can exist",async()=>{
  const p=await seed();await pg.query("UPDATE outreach_messages SET status='accepted',accepted_at=now()-interval '4 days' WHERE id=$1",[p.id]);
  const follow=crypto.randomUUID();await pg.query("INSERT INTO outreach_messages(id,prospect_id,subject,body,status,followup_of,approved_by,scheduled_at,wire_message_id) VALUES($1,$2,'Follow-up','Following up on your requested information','queued',$3,$4,now(),$5)",[follow,p.prospectId,p.id,admin,`${follow}@sendascout.com`]);
  assert.equal((await claim(follow)).rows.length,0);await pg.query("UPDATE outreach_messages SET last_checked_at=now() WHERE id=$1",[p.id]);assert.equal((await claim(follow)).rows.length,1);
  await pg.query("UPDATE outreach_messages SET status='queued' WHERE id=$1",[follow]);await pg.query("UPDATE outreach_messages SET reply_at=now(),status='replied' WHERE id=$1",[p.id]);assert.equal((await claim(follow)).rows.length,0);
  await assert.rejects(pg.query("INSERT INTO outreach_messages(prospect_id,subject,body,followup_of,wire_message_id) VALUES($1,'Another','Another',$2,'another@sendascout.com')",[p.prospectId,p.id]));
});
test("paid account matches block sending and cancel queued prospecting",async()=>{
  const p=await seed(),customer=crypto.randomUUID(),mission=crypto.randomUUID();
  await pg.query("INSERT INTO users(id,clerk_user_id,email,role) VALUES($1,$2,$3,'customer')",[customer,customer,p.email]);
  await pg.query("INSERT INTO missions(id,customer_id,type,title,instructions,address_line_1,city,state,zip,customer_price_cents,scout_payout_cents,platform_fee_cents) VALUES($1,$2,'see','Fixture','Fixture','123 Example','Sample','NC','28562',3900,2200,1700)",[mission,customer]);
  await pg.query("INSERT INTO payments(mission_id,customer_id,kind,amount_cents,scout_payout_cents,platform_fee_cents,status,idempotency_key,stripe_transfer_group) VALUES($1,$2,'booking',3900,2200,1700,'paid',$3,$3)",[mission,customer,mission]);
  assert.equal((await claim(p.id)).rows.length,0);await execute(reconcileOutreachCustomers());assert.equal((await state(p.id)).status,"cancelled");assert.equal((await pg.query<{stage:string}>("SELECT stage FROM outreach_prospects WHERE id=$1",[p.prospectId])).rows[0].stage,"customer");
});

function worker(mock:(path:string,body?:unknown)=>Promise<unknown>,failAcceptedWrite=false) {
  const modules:Record<string,unknown>={"server-only":{},"drizzle-orm":orm,"@/db":{getDb:()=>({execute:async(query:Parameters<typeof dialect.sqlToQuery>[0])=>{if(failAcceptedWrite&&dialect.sqlToQuery(query).sql.includes("WITH accepted AS"))throw new Error("Database write interrupted");return execute(query);}})},"@/lib/outreach-content":{businessHours:()=>true},"@/lib/outreach-mail":{outreachRawEmail},"@/lib/outreach-google":{googleOutreachConfigured:()=>true,outreachAccessToken:async()=>"fake-access",gmailRequest:(_access:string,path:string,body?:unknown)=>mock(path,body)},"@/lib/outreach-sql":{claimOutreachMessage,reconcileOutreachCustomers}};
  const service:Record<string,(options?:{send?:boolean})=>Promise<Record<string,unknown>>>={};const js=ts.transpileModule(readFileSync("lib/outreach-worker.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","exports","process","console",js)((name:string)=>{assert.ok(name in modules,name);return modules[name];},service,{env:{VERCEL_ENV:"production"}},{info:()=>{},error:()=>{}});return service;
}
test("Gmail timeout never auto-resends; a later Sent-mail match reconciles acceptance",async()=>{
  const p=await seed();await pg.exec("UPDATE outreach_settings SET lease_until=NULL");let sends=0;let found=false;
  const service=worker(async(path)=>{if(path==="/messages/send"){sends++;throw new Error("timeout");}if(path.startsWith("/messages?"))return {messages:found?[{id:"provider-id",threadId:"thread-id"}]:[]};if(path.startsWith("/threads/"))return {messages:[{id:"provider-id",labelIds:["SENT"],internalDate:String(Date.now())}]};throw new Error(path);});
  await service.runOutreachWorker();assert.equal(sends,1);assert.equal((await state(p.id)).status,"unknown");
  await service.runOutreachWorker();assert.equal(sends,1);found=true;await service.runOutreachWorker();assert.equal(sends,1);assert.equal((await state(p.id)).status,"accepted");
});
test("provider acceptance followed by a database failure stays unknown, without a second send",async()=>{
  const p=await seed();await pg.exec("UPDATE outreach_settings SET lease_until=NULL");let sends=0;
  await worker(async()=>{sends++;return {id:"accepted-id",threadId:"accepted-thread"};},true).runOutreachWorker();assert.equal(sends,1);assert.equal((await state(p.id)).status,"unknown");
});
test("incoming responses cancel queued follow-ups and manual sync never sends",async()=>{
  const p=await seed();await pg.query("UPDATE outreach_messages SET status='accepted',google_message_id='a',google_thread_id='t',sender_mailbox='support@sendascout.com',attempted_at=now()-interval '4 days',accepted_at=now()-interval '4 days' WHERE id=$1",[p.id]);
  const follow=crypto.randomUUID();await pg.query("INSERT INTO outreach_messages(id,prospect_id,subject,body,status,followup_of,approved_by,scheduled_at,wire_message_id) VALUES($1,$2,'Follow-up','Enough message body for sending','queued',$3,$4,now(),$5)",[follow,p.prospectId,p.id,admin,`${follow}@sendascout.com`]);await pg.exec("UPDATE outreach_settings SET lease_until=NULL");let sends=0;
  const service=worker(async(path)=>{if(path==="/messages/send"){sends++;return {id:"bad",threadId:"bad"};}return {messages:[{id:"reply",labelIds:["INBOX"],internalDate:String(Date.now())}]};});
  await service.runOutreachWorker({send:false});assert.equal(sends,0);assert.equal((await state(p.id)).status,"replied");assert.equal((await state(follow)).status,"cancelled");
});

test("server actions authenticate, preserve import suppression, save drafts and enforce explicit approval",async()=>{
  let authorized=false;let authChecks=0;
  const modules:Record<string,unknown>={"drizzle-orm":orm,"next/cache":{revalidatePath:()=>{}},"next/navigation":{unstable_rethrow:()=>{}},"@/db":{getDb:()=>({execute})},"@/lib/app-user":{requireAdminUser:async()=>{authChecks++;if(!authorized)throw new Error("Not authorized");return {id:admin};}},"@/lib/outreach-content":{parseProspectCsv,prospectInput,tailoredDraft},"@/lib/outreach-google":{googleOutreachConfigured:()=>true},"@/lib/outreach-worker":{runOutreachWorker:async()=>({skipped:"test"})}};
  const actions:Record<string,(state:unknown,form:FormData)=>Promise<{ok:boolean;message:string;href?:string}>>={};
  const js=ts.transpileModule(readFileSync("app/actions/outreach.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","exports",js)((name:string)=>{assert.ok(name in modules,name);return modules[name];},actions);
  const form=(data:Record<string,string>)=>{const f=new FormData();for(const [k,v] of Object.entries(data))f.set(k,v);return f;};
  const input={company:"Action fixture",email:"action@example.test",segment:"property"};
  assert.equal((await actions.createOutreachProspect({},form(input))).ok,false);assert.equal((await pg.query("SELECT * FROM outreach_prospects")).rows.length,0);
  authorized=true;const created=await actions.createOutreachProspect({},form(input));assert.equal(created.ok,true);const id=created.href!.split("/").at(-1)!;
  assert.equal((await actions.generateOutreachDraft({},form({id}))).ok,true);
  const draft=(await pg.query<{id:string}>("SELECT id FROM outreach_messages WHERE prospect_id=$1",[id])).rows[0];
  assert.equal((await actions.queueOutreachMessage({},form({messageId:draft.id,reviewed:"yes"}))).ok,false);
  assert.equal((await actions.updateOutreachProspect({},form({id,stage:"new",permission:"requested",permissionNote:"Requested a sample by email today"}))).ok,true);
  assert.equal((await actions.saveOutreachDraft({},form({messageId:draft.id,subject:"A reviewed subject",body:"A reviewed message with enough content for a useful introduction."}))).ok,true);
  assert.equal((await actions.queueOutreachMessage({},form({messageId:draft.id}))).ok,false);
  assert.equal((await actions.queueOutreachMessage({},form({messageId:draft.id,reviewed:"yes"}))).ok,true);
  assert.equal((await state(draft.id)).status,"queued");
  assert.equal((await actions.updateOutreachProspect({},form({id,stage:"unsubscribed",permission:"research_only"}))).ok,true);
  assert.equal((await state(draft.id)).status,"cancelled");
  assert.equal((await actions.importOutreachProspects({},form({csv:"company,email,segment\nChanged,ACTION@example.test,vehicle"}))).ok,true);
  const record=(await pg.query<{company:string;suppressed_at:string}>("SELECT * FROM outreach_prospects WHERE id=$1",[id])).rows[0];assert.equal(record.company,"Action fixture");assert.ok(record.suppressed_at);assert.ok(authChecks>=10);
});
