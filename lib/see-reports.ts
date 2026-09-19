import "server-only";
import { get, put } from "@vercel/blob";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "@/db";
import { missions, seeReports } from "@/db/schema";
import { buildSeePdf } from "@/lib/see-pdf";
import { notifyUserOnce } from "@/lib/notifications";

export async function generateSeeReport(reportId: string) {
  const db = getDb();
  const claimed = await db.execute<{ id: string }>(sql`UPDATE see_reports SET status='processing', attempts=attempts+1, updated_at=now() WHERE id=${reportId} AND attempts<5 AND (status IN ('pending','failed') OR (status='processing' AND updated_at<now()-interval '10 minutes')) RETURNING id`);
  if (!claimed.rows.length) return;
  const [report] = await db.select().from(seeReports).where(eq(seeReports.id,reportId));
  if (!report) return;
  try {
    const bytes = await buildSeePdf(report.snapshot, async filePath => {
      const blob = await get(filePath,{access:"private"});
      if (!blob || blob.statusCode!==200) throw new Error("A report photo could not be loaded. Re-upload the missing evidence.");
      const data=Buffer.from(await new Response(blob.stream).arrayBuffer());
      if(data.length>10*1024*1024) throw new Error("Report photos must be 10 MB or smaller.");
      const image=sharp(data,{failOn:"warning",limitInputPixels:40_000_000});const metadata=await image.metadata();
      if(!["jpeg","png","webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height || metadata.width<64 || metadata.height<64) throw new Error("A report photo is unreadable or too small. Request a corrected photo.");
      return image.rotate().resize({width:1600,height:1600,fit:"inside",withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
    });
    const stored = await put(`see-reports/${report.missionId}/r${report.revision}-${crypto.randomUUID()}.pdf`,Buffer.from(bytes),{access:"private",contentType:"application/pdf",addRandomSuffix:false});
    const needsReview = report.snapshot.items.some(item=>Boolean(item.unavailableReason));
    const status = needsReview ? "review" : "ready";
    await db.execute(sql`WITH saved AS (
      UPDATE see_reports SET status=${status}, storage_path=${stored.pathname}, error=NULL, updated_at=now() WHERE id=${report.id} AND status='processing' AND attempts=${report.attempts} RETURNING mission_id,revision
    ) UPDATE missions SET see_report_status=${status}, see_report_released_at=CASE WHEN ${!needsReview} THEN now() ELSE NULL END, updated_at=now() FROM saved WHERE missions.id=saved.mission_id AND missions.see_report_revision=saved.revision AND missions.status='submitted'`);
  } catch(error) {
    const message=error instanceof Error?error.message:"PDF generation failed";
    await db.execute(sql`WITH failed AS (UPDATE see_reports SET status='failed', error=${message.slice(0,1000)}, updated_at=now() WHERE id=${report.id} AND status='processing' AND attempts=${report.attempts} RETURNING mission_id,revision) UPDATE missions SET see_report_status='failed',updated_at=now() FROM failed WHERE missions.id=failed.mission_id AND missions.see_report_revision=failed.revision AND missions.status='submitted'`);
    console.error("See It report generation failed",{missionId:report.missionId,reportId,message});
  }
}
export async function reconcileSeeReports() {
  const db=getDb();
  const pending=await db.execute<{id:string}>(sql`SELECT report.id FROM see_reports report JOIN missions mission ON mission.id=report.mission_id AND mission.see_report_revision=report.revision WHERE mission.archived_at IS NULL AND mission.status='submitted' AND report.attempts<5 AND (report.status='pending' OR (report.status='failed' AND report.updated_at<now()-interval '5 minutes') OR (report.status='processing' AND report.updated_at<now()-interval '10 minutes')) ORDER BY report.created_at LIMIT 8`);
  for(const report of pending.rows) await generateSeeReport(report.id);
  const released = await db.select({id:missions.id,customerId:missions.customerId,revision:missions.seeReportRevision}).from(missions).where(and(eq(missions.seeReportStatus,"ready"),sql`${missions.seeReportReleasedAt}>now()-interval '7 days'`));
  for(const mission of released) await notifyUserOnce({recipientUserId:mission.customerId,missionId:mission.id,kind:"see_report_ready",dedupeScope:`revision:${mission.revision}`,title:"Your See It report is ready",body:"Your photos, video, and written observations are ready. Open your mission to review the evidence and download the PDF. Your 24-hour review window starts when the report is released.",actionLabel:"View and download report",actionUrl:`https://www.sendascout.com/dashboard/missions/${mission.id}`});
  return {processed:pending.rows.length,released:released.length};
}
