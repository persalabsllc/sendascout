"use server";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/db";
import { requireAdminUser } from "@/lib/app-user";
import { generateSeeReport } from "@/lib/see-reports";
type Result={ok:true}|{ok:false;error:string};
export async function updateSeeOfferSettings(id:string,paused:boolean,capCents:number,note:string):Promise<Result>{
 try{const admin=await requireAdminUser();if(!Number.isInteger(capCents)||capCents<0||note.trim().length<5)throw new Error("Enter a valid cap and a brief audit note.");
 const result=await getDb().execute(sql`WITH changed AS (UPDATE missions SET see_boost_paused=${paused},see_payout_cap_cents=${capCents},updated_at=now() WHERE id=${id} AND see_template_key IS NOT NULL AND status='open' AND scout_id IS NULL AND archived_at IS NULL AND ${capCents}>=scout_payout_cents AND ${capCents}>=see_base_payout_cents AND ${capCents}<=customer_price_cents RETURNING id),audited AS (INSERT INTO mission_updates (mission_id,author_id,status,message) SELECT id,${admin.id},'open'::mission_status,${`Offer settings: automatic increases ${paused?"paused":"enabled"}; cap $${(capCents/100).toFixed(2)}. ${note.trim().slice(0,500)}`} FROM changed RETURNING id) SELECT id FROM changed`);
 if(!result.rows.length)throw new Error("Only an unclaimed mission can be changed. The cap must cover the current offer and stay within the funded customer price.");revalidatePath("/control-room/see-it");return {ok:true};
 }catch(e){unstable_rethrow(e);return {ok:false,error:e instanceof Error?e.message:"Could not update offer settings."};}
}
export async function reviewSeeReport(id:string,revision:number,decision:"release"|"correct"|"retry",note:string):Promise<Result>{
 try{const admin=await requireAdminUser();if(!["release","correct","retry"].includes(decision)||!Number.isInteger(revision)||note.trim().length<10)throw new Error("Add a clear review note of at least 10 characters.");
 const state=decision==="release"?"ready":decision==="correct"?"correction":"pending";
 const result=await getDb().execute<{id:string}>(sql`WITH locked AS MATERIALIZED (SELECT id FROM missions WHERE id=${id} AND see_template_key IS NOT NULL AND status='submitted' AND archived_at IS NULL AND see_report_revision=${revision} FOR UPDATE),reviewed AS (
 UPDATE see_reports report SET status=${state},reviewed_by=${admin.id},review_note=${note.trim().slice(0,1500)},attempts=CASE WHEN ${decision==="retry"} THEN 0 ELSE report.attempts END,updated_at=now()
 FROM locked WHERE report.mission_id=locked.id AND report.revision=${revision} AND report.status IN ('review','failed') AND (${decision!=="release"} OR report.storage_path IS NOT NULL) RETURNING report.id,report.mission_id
 ),changed AS (UPDATE missions SET see_report_status=${state},see_report_released_at=CASE WHEN ${decision==="release"} THEN now() ELSE NULL END,status=CASE WHEN ${decision==="correct"} THEN 'onsite'::mission_status ELSE missions.status END,updated_at=now() FROM reviewed WHERE missions.id=reviewed.mission_id RETURNING missions.id),audited AS (INSERT INTO mission_updates (mission_id,author_id,status,message) SELECT id,${admin.id},CASE WHEN ${decision==="correct"} THEN 'onsite'::mission_status ELSE 'submitted'::mission_status END,${`Report review: ${decision}. ${note.trim().slice(0,1500)}`} FROM changed RETURNING id) SELECT reviewed.id FROM reviewed`);
 const reportId=result.rows[0]?.id;if(!reportId)throw new Error("This report changed or is not awaiting review. Refresh the queue.");if(decision==="retry")after(()=>generateSeeReport(reportId));
 revalidatePath("/control-room/see-it");revalidatePath(`/dashboard/missions/${id}`);return {ok:true};
 }catch(e){unstable_rethrow(e);return {ok:false,error:e instanceof Error?e.message:"Could not review report."};}
}
export async function addSeeRecruitmentNote(id:string,note:string):Promise<Result>{
 try{const admin=await requireAdminUser();if(note.trim().length<10)throw new Error("Add the recruiting channel and outcome.");const result=await getDb().execute(sql`INSERT INTO mission_updates(mission_id,author_id,status,message) SELECT id,${admin.id},status,${`Recruiting note: ${note.trim().slice(0,1500)}`} FROM missions WHERE id=${id} AND see_template_key IS NOT NULL AND archived_at IS NULL RETURNING id`);if(!result.rows.length)throw new Error("Mission not found.");revalidatePath("/control-room/see-it");return {ok:true};}catch(e){unstable_rethrow(e);return {ok:false,error:e instanceof Error?e.message:"Could not save note."};}
}
