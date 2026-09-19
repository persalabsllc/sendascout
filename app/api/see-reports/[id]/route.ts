import { get } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { missions, seeReports } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!/^[0-9a-f-]{36}$/i.test(id))return new NextResponse("Not found",{status:404});
 const user=await requireAppUser("customer");
 const [mission]=await getDb().select().from(missions).where(eq(missions.id,id));
 if(!mission || ![mission.customerId,mission.scoutId].includes(user.id)&&user.role!=="admin")return new NextResponse("Not found",{status:404});
 const [report]=await getDb().select().from(seeReports).where(and(eq(seeReports.missionId,id),eq(seeReports.revision,mission.seeReportRevision)));
 if(!report?.storagePath || user.role!=="admin" && (report.status!=="ready" || mission.seeReportStatus!=="ready"))return new NextResponse("Report is not ready",{status:409});
 const blob=await get(report.storagePath,{access:"private"});if(!blob||blob.statusCode!==200)return new NextResponse("Report temporarily unavailable",{status:503});
 return new NextResponse(blob.stream,{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="Send-a-Scout-${id.slice(0,8)}-report-r${report.revision}.pdf"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}
