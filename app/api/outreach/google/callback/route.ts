import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireAdminUser } from "@/lib/app-user";
import { getDb } from "@/db";
import { encryptOutreachToken } from "@/lib/outreach-mail";
import { gmailRequest, googleToken, GOOGLE_CALLBACK, GOOGLE_SCOPES, outreachMailbox } from "@/lib/outreach-google";
export async function GET(request:Request) {
  const admin=await requireAdminUser();const cookieJar=await cookies();
  const url=new URL(request.url),state=url.searchParams.get("state")||"",cookie=cookieJar.get("outreach_oauth")?.value||"";
  cookieJar.delete({name:"outreach_oauth",path:"/api/outreach/google"});
  const back=(value:string)=>NextResponse.redirect(new URL(`/control-room/outreach?connection=${value}`,GOOGLE_CALLBACK));
  if(process.env.VERCEL_ENV!=="production"||!state||!cookie||Buffer.byteLength(state)!==Buffer.byteLength(cookie)||!timingSafeEqual(Buffer.from(state),Buffer.from(cookie)))return back("failed");
  const stored=await getDb().execute<{verifier:string}>(sql`DELETE FROM outreach_oauth_states WHERE state_hash=${createHash("sha256").update(state).digest("hex")} AND admin_id=${admin.id}::uuid AND expires_at>now() RETURNING verifier`);
  if(!stored.rows[0]||!url.searchParams.get("code"))return back("failed");
  try {
    const tokens=await googleToken({grant_type:"authorization_code",code:url.searchParams.get("code")!,redirect_uri:GOOGLE_CALLBACK,code_verifier:stored.rows[0].verifier});
    if(!tokens.refresh_token||!GOOGLE_SCOPES.every(scope=>tokens.scope?.split(" ").includes(scope)))return back("permissions");
    const profile=await gmailRequest<{emailAddress:string}>(tokens.access_token,"/profile");
    if(profile.emailAddress.toLowerCase()!==outreachMailbox())return back("mailbox");
    const saved=await getDb().execute(sql`UPDATE outreach_settings SET mailbox=${profile.emailAddress.toLowerCase()},refresh_token_encrypted=${encryptOutreachToken(tokens.refresh_token,process.env.OUTREACH_TOKEN_KEY!)},connected_at=now(),paused=true,last_error=NULL,updated_at=now() WHERE id=1 AND (lease_until IS NULL OR lease_until<now()) RETURNING id`);
    if(!saved.rows.length)return back("failed");
    return back("connected");
  } catch {return back("failed");}
}
