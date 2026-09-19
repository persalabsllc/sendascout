"use server";
import { seeSubmissionSql } from "@/lib/see-submission-sql";
import { head } from "@vercel/blob";
import { and, asc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { missionChecklistItems, missions, seeMissionDrafts } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
import { seeResultComplete, type SeeSnapshot } from "@/lib/see-it";
import type { SeeDraft, SeeReportSnapshot } from "@/lib/see-report-types";
import { generateSeeReport } from "@/lib/see-reports";

type Result = {ok:true} | {ok:false;error:string};
function cleanDraft(missionId:string,data:SeeDraft):SeeDraft {
  if(!data || typeof data.summary!=="string" || !Array.isArray(data.answers) || data.answers.length>30) throw new Error("Invalid mission draft.");
  const draft={summary:data.summary.trim().slice(0,5000),answers:data.answers.map(answer=>({itemId:String(answer.itemId),text:String(answer.text ?? "").trim().slice(0,3000),unavailableReason:String(answer.unavailableReason ?? "").trim().slice(0,500),files:(Array.isArray(answer.files)?answer.files:[]).map(file=>({path:String(file.path),contentType:String(file.contentType),bytes:Number(file.bytes),uploadedAt:String(file.uploadedAt),deviceTimestamp:file.deviceTimestamp && !Number.isNaN(Date.parse(file.deviceTimestamp)) ? new Date(file.deviceTimestamp).toISOString() : undefined}))}))};
  const files=draft.answers.flatMap(answer=>answer.files);
  if(files.length>30 || new Set(files.map(file=>file.path)).size!==files.length) throw new Error("Each uploaded file must belong to one checklist item. Use separate photos for separate views.");
  if(files.some(file=>!file.path.startsWith(`mission-results/${missionId}/`) || /\.\.|[\\\r\n]/.test(file.path) || file.path.length>300)) throw new Error("An evidence file does not belong to this mission.");
  if(new Set(draft.answers.map(answer=>answer.itemId)).size!==draft.answers.length) throw new Error("Duplicate checklist answers are not allowed.");
  return draft;
}
async function assignedMission(id:string) {
  const user=await requireAppUser("scout");
  const [mission]=await getDb().select().from(missions).where(and(eq(missions.id,id),eq(missions.scoutId,user.id)));
  if(!mission?.seeTemplateKey || mission.archivedAt || mission.status!=="onsite" || mission.paymentStatus!=="paid") throw new Error("This mission is not accepting evidence. Refresh to check its status.");
  return {user,mission};
}
export async function loadSeeDraft(id:string):Promise<{ok:true;draft:SeeDraft|null}|{ok:false;error:string}> {
  try {const {user}=await assignedMission(id);const [row]=await getDb().select().from(seeMissionDrafts).where(and(eq(seeMissionDrafts.missionId,id),eq(seeMissionDrafts.scoutId,user.id)));return {ok:true,draft:row?.data??null};}catch(e){unstable_rethrow(e);return {ok:false,error:e instanceof Error?e.message:"Could not load draft."};}
}
export async function saveSeeDraft(id:string,raw:SeeDraft):Promise<Result> {
  try {const {user}=await assignedMission(id);const draft=cleanDraft(id,raw);
    const saved=await getDb().execute(sql`INSERT INTO see_mission_drafts (mission_id,scout_id,data) SELECT id,scout_id,${JSON.stringify(draft)}::jsonb FROM missions WHERE id=${id} AND scout_id=${user.id} AND status='onsite' AND archived_at IS NULL ON CONFLICT (mission_id) DO UPDATE SET data=EXCLUDED.data,scout_id=EXCLUDED.scout_id,updated_at=now() RETURNING mission_id`);
    if(!saved.rows.length)throw new Error("The mission changed before the draft was saved.");return {ok:true};
  }catch(e){unstable_rethrow(e);return {ok:false,error:e instanceof Error?e.message:"Could not save draft."};}
}
export async function submitSeeResults(id:string,raw:SeeDraft):Promise<Result> {
  try {
    const {user,mission}=await assignedMission(id);const db=getDb();const draft=cleanDraft(id,raw);const contract=mission.seeTemplateSnapshot as SeeSnapshot;
    const checklist=await db.select().from(missionChecklistItems).where(eq(missionChecklistItems.missionId,id)).orderBy(asc(missionChecklistItems.sequence));
    if(draft.answers.length!==checklist.length || draft.answers.some(answer=>!checklist.some(item=>item.id===answer.itemId)))throw new Error("Complete the mission’s full checklist.");
    for(const file of draft.answers.flatMap(answer=>answer.files)) {
      const metadata=await head(file.path);
      if(metadata.pathname!==file.path || !["image/jpeg","image/png","image/webp","video/mp4","video/quicktime","video/webm"].includes(metadata.contentType) || metadata.size<=0 || metadata.size>(metadata.contentType.startsWith("image/")?10:50)*1024*1024)throw new Error("Use readable photos up to 10 MB and videos up to 50 MB.");
      file.contentType=metadata.contentType;file.bytes=metadata.size;file.uploadedAt=metadata.uploadedAt.toISOString();
      if(metadata.uploadedAt.getTime()<(mission.claimedAt?.getTime()??0))throw new Error("Evidence must be uploaded after this mission was claimed.");
    }
    const files=draft.answers.flatMap(answer=>answer.files);
    if(files.reduce((sum,file)=>sum+file.bytes,0)>250*1024*1024)throw new Error("Total mission evidence must be 250 MB or less.");
    if(files.filter(file=>file.contentType.startsWith("image/")).length>contract.template.maxPhotos || files.filter(file=>file.contentType.startsWith("video/")).length>contract.template.maxVideos)throw new Error("The evidence exceeds the photo or video allowance for this check.");
    const now=new Date();
    const items=checklist.map(item=>{const answer=draft.answers.find(answer=>answer.itemId===item.id)!;const photos=answer.files.filter(f=>f.contentType.startsWith("image/"));const videos=answer.files.filter(f=>f.contentType.startsWith("video/"));
      if(!seeResultComplete({responseType:item.responseType,responseText:answer.text,photoCount:photos.length,videoCount:videos.length,unavailableReason:answer.unavailableReason}))throw new Error(`Complete “${item.prompt}” or explain why it could not be checked (at least 10 characters).`);
      if(item.taskKey==="wheels" && photos.length<4 && !answer.unavailableReason)throw new Error("Include one photo of each wheel / tire, or explain any access limitation.");
      if((item.responseType==="photo" && videos.length) || (item.responseType==="video" && photos.length) || (item.responseType==="text" && answer.files.length))throw new Error(`Use the requested evidence type for “${item.prompt}”.`);
      return {id:item.id,prompt:item.prompt,responseType:item.responseType,text:answer.text,unavailableReason:answer.unavailableReason,files:answer.files};});
    const snapshot:SeeReportSnapshot={missionId:id,revision:mission.seeReportRevision+1,title:mission.title,templateName:contract.template.name,templateVersion:contract.version,address:[mission.addressLine1,mission.addressLine2,mission.city,mission.state,mission.zip].filter(Boolean).join(", "),timeZone:mission.timezone,submittedAt:now.toISOString(),visitAt:mission.verifiedCheckInAt?.toISOString()??null,locationVerified:Boolean(mission.verifiedCheckInAt),latitude:mission.verifiedCheckInLatitude,longitude:mission.verifiedCheckInLongitude,accuracyMeters:mission.verifiedCheckInAccuracyMeters,scoutName:(mission.scoutDisplayNameSnapshot||user.firstName||"Scout").split(/\s+/)[0],scoutId:user.id,summary:draft.summary,requestedFocus:contract.configuration.focus,items};
    const evidence=items.flatMap(item=>item.files.map(file=>({item_id:item.id,path:file.path,content_type:file.contentType,bytes:file.bytes,kind:item.responseType==="video"?"checklist_video":"checklist_photo",caption:item.prompt})));
    const updated=await db.execute<{report_id:string}>(seeSubmissionSql({id,scoutId:user.id,previousRevision:mission.seeReportRevision,now,snapshot,items,evidence,summary:draft.summary}));
    const reportId=updated.rows[0]?.report_id;if(!reportId)throw new Error("The mission changed or has an unresolved case or payment. Refresh before submitting again.");
    after(async()=>{await generateSeeReport(reportId);});
    revalidatePath(`/dashboard/missions/${id}`);revalidatePath("/control-room/see-it");return {ok:true};
  }catch(e){unstable_rethrow(e);console.error("See It submission failed",e);return {ok:false,error:e instanceof Error?e.message:"Could not submit this check."};}
}
