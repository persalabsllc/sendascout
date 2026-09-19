import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { platformActivityEmail } from "../lib/platform-activity-email.ts";
import { claimActivityAlert } from "../lib/platform-activity-sql.ts";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as orm from "drizzle-orm";

const db = new PGlite();
const dialect = new PgDialect();
const customer = "10000000-0000-4000-8000-000000000001";
const historical = "20000000-0000-4000-8000-000000000001";
async function mission(id: string, paid = false) {
  await db.query(`INSERT INTO missions(id,customer_id,type,status,payment_status,title,instructions,address_line_1,city,state,zip,customer_price_cents,scout_payout_cents,platform_fee_cents) VALUES($1,$2,'see',$3,$4,'Property check','Front photo','123 Example Street','Riverhead','NY','11901',3900,2200,1700)`, [id,customer,paid ? 'open' : 'draft',paid ? 'paid' : 'pending']);
}
before(async () => {
  const migrations = readMigrationFiles({ migrationsFolder: "./db/migrations" });
  for (const migration of migrations.slice(0,-1)) for (const statement of migration.sql) await db.exec(statement);
  await db.query("INSERT INTO users(id,clerk_user_id,email,role) VALUES($1,'old-customer','old@example.test','customer')", [customer]);
  await mission(historical,true);
  for (const statement of migrations.at(-1)!.sql) await db.exec(statement);
});
after(() => db.close());
async function events(key: string) { return (await db.query<{id:string;status:string;payload:Record<string,string|number>}>("SELECT * FROM platform_activity_alerts WHERE event_key=$1",[key])).rows; }
async function claim(id: string, subject = "Original") {
  const query = dialect.sqlToQuery(claimActivityAlert(id,crypto.randomUUID(),{from:"test@example.test",to:["support@sendascout.com"],subject,text:"body",html:"body"}));
  return db.query<{request_payload:{subject:string}}>(query.sql,query.params);
}

test("activation queues one setup email without replaying historical activity", async () => {
  assert.equal((await events("platform_activity_alerts:enabled:v1")).length,1);
  assert.equal((await events(`customer_created:${customer}`)).length,0);
  assert.equal((await events(`mission_launched:${historical}`))[0].status,"ignored");
  await db.query("UPDATE missions SET status='open' WHERE id=$1",[historical]);
  assert.equal((await events(`mission_launched:${historical}`))[0].status,"ignored");
});
test("customer and Scout signups are unique, including conversion and repeated onboarding", async () => {
  for (const role of ["customer","scout","admin"]) {
    const id = crypto.randomUUID();
    await db.query("INSERT INTO users(id,clerk_user_id,email,role) VALUES($1,$2,$3,$4)",[id,`clerk-${id}`,`${id}@example.test`,role]);
    assert.equal((await events(`${role==='scout'?'scout_signup':'customer_created'}:${id}`)).length,role==='admin'?0:1);
    if(role==='customer') {
      await db.query("UPDATE users SET role='scout' WHERE id=$1",[id]);
      await db.query("UPDATE users SET role='scout' WHERE id=$1",[id]);
      assert.equal((await events(`scout_signup:${id}`)).length,1);
    }
  }
});
test("only paid launched missions alert; repeats, price changes and reopening do not duplicate",async () => {
  const id=crypto.randomUUID(); await mission(id);
  assert.equal((await events(`mission_launched:${id}`)).length,0);
  await db.query("UPDATE missions SET payment_status='paid' WHERE id=$1",[id]);
  assert.equal((await events(`mission_launched:${id}`)).length,0);
  await db.query("UPDATE missions SET status='open',see_deadline_at=now()+interval '72 hours' WHERE id=$1",[id]);
  let rows=await events(`mission_launched:${id}`);
  assert.equal(rows.length,1); assert.equal(rows[0].payload.scoutPayoutCents,2200); assert.ok(rows[0].payload.deadline);
  await db.query("UPDATE missions SET status='open',scout_payout_cents=2600,platform_fee_cents=1300 WHERE id=$1",[id]);
  await db.query("UPDATE missions SET status='draft' WHERE id=$1",[id]);
  await db.query("UPDATE missions SET status='open' WHERE id=$1",[id]);
  rows=await events(`mission_launched:${id}`); assert.equal(rows.length,1); assert.equal(rows[0].payload.scoutPayoutCents,2200);
});
test("a rolled-back launch cannot produce an operations email",async () => {
  const id=crypto.randomUUID(); await mission(id);
  await db.exec("BEGIN"); await db.query("UPDATE missions SET status='open',payment_status='paid' WHERE id=$1",[id]); await db.exec("ROLLBACK");
  assert.equal((await events(`mission_launched:${id}`)).length,0);
});
test("claims are exclusive, retries freeze payload, accepted or expired events cannot resend",async () => {
  const id=(await events("platform_activity_alerts:enabled:v1"))[0].id;
  assert.equal((await claim(id)).rows.length,1); assert.equal((await claim(id)).rows.length,0);
  await db.query("UPDATE platform_activity_alerts SET last_attempt_at=now()-interval '6 minutes' WHERE id=$1",[id]);
  assert.equal((await claim(id,"Changed")).rows[0].request_payload.subject,"Original");
  await db.query("UPDATE platform_activity_alerts SET status='pending',first_attempt_at=now()-interval '24 hours' WHERE id=$1",[id]);
  assert.equal((await claim(id)).rows.length,0);
  await db.query("UPDATE platform_activity_alerts SET first_attempt_at=now(),status='accepted',provider_message_id='provider-id' WHERE id=$1",[id]);
  assert.equal((await claim(id)).rows.length,0);
});
test("emails use the fixed operations recipient, actionable details and escaped user content",() => {
  const email=platformActivityEmail("mission_launched",{missionId:"abc",missionType:"see",location:"Riverhead, NY",title:"<script>bad</script>",customerPriceCents:3900,scoutPayoutCents:2200,deadline:"2026-09-22T20:00:00Z",timeZone:"America/New_York"},"Send a Scout <alerts@sendascout.com>");
  assert.deepEqual(email.to,["support@sendascout.com"]); assert.match(email.subject,/MISSION LIVE.*SEE IT/);
  assert.match(email.text,/\$39\.00/); assert.match(email.text,/\$22\.00/); assert.match(email.text,/America\/New_York/);
  assert.match(email.text,/dashboard\/missions\/abc/); assert.doesNotMatch(email.html,/<script>/); assert.match(email.html,/&lt;script&gt;/);
  assert.match(platformActivityEmail("scout_signup",{},"sender").text,/not approval/);
  assert.match(platformActivityEmail("customer_created",{},"sender").subject,/NEW CUSTOMER/);
  assert.match(platformActivityEmail("alerts_enabled",{},"sender").text,/one-time setup confirmation/);
  assert.doesNotThrow(()=>platformActivityEmail("customer_created",{createdAt:"2026-09-19T12:00:00Z",timeZone:"bad"},"sender"));
});

test("worker isolates previews and retries ambiguous provider outcomes with identical requests",async () => {
  await db.exec("UPDATE platform_activity_alerts SET status='ignored'");
  const id=crypto.randomUUID();
  await db.query("INSERT INTO platform_activity_alerts(id,event_key,kind,payload) VALUES($1,'worker-fixture','alerts_enabled','{}')",[id]);
  const requests: { headers:Record<string,string>; body:string }[]=[];
  let mode="preview"; let fail=true;
  const modules:Record<string,unknown>={
    "server-only":{},"next/server":{after:()=>{throw new Error("Outside request");}},"drizzle-orm":orm,
    "@/db":{getDb:()=>({execute:async (query:Parameters<typeof dialect.sqlToQuery>[0])=>{const q=dialect.sqlToQuery(query);return db.query(q.sql,q.params);}})},
    "@/lib/platform-activity-email":{platformActivityEmail},"@/lib/platform-activity-sql":{claimActivityAlert},
  };
  const service:Record<string,()=>Promise<Record<string,unknown>>>={};
  const js=ts.transpileModule(readFileSync("lib/platform-activity-alerts.ts","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function("require","exports","process","fetch","console",js)(
    (name:string)=>{assert.ok(name in modules,name);return modules[name];}, service,
    {env:{get VERCEL_ENV(){return mode;},RESEND_API_KEY:"test-only"}},
    async (_url:string,request:{headers:Record<string,string>;body:string})=>{requests.push(request);if(fail)throw new Error("timeout");return {ok:true,status:200,json:async()=>({id:"resend-fixture"})};},
    {info:()=>{},error:()=>{}},
  );
  assert.deepEqual(await service.flushPlatformActivityAlerts(),{skipped:"not_production"});assert.equal(requests.length,0);
  assert.doesNotThrow(()=>service.schedulePlatformActivityAlerts());
  mode="production";
  assert.equal((await service.flushPlatformActivityAlerts()).errors,1);
  assert.equal(requests.length,1);
  await service.flushPlatformActivityAlerts();assert.equal(requests.length,1); // Wait for retry interval.
  await db.query("UPDATE platform_activity_alerts SET next_attempt_at=now() WHERE id=$1",[id]);
  fail=false;
  assert.equal((await service.flushPlatformActivityAlerts()).accepted,1);
  assert.equal(requests[0].headers["Idempotency-Key"],requests[1].headers["Idempotency-Key"]);
  assert.equal(requests[0].body,requests[1].body);
  assert.deepEqual(JSON.parse(requests[1].body).to,["support@sendascout.com"]);
  await service.flushPlatformActivityAlerts();assert.equal(requests.length,2);
  assert.equal((await events("worker-fixture"))[0].status,"accepted");
});
