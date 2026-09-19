import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireAdminUser } from "@/lib/app-user";
import { getDb } from "@/db";
import { googleOutreachConfigured, GOOGLE_CALLBACK, GOOGLE_SCOPES, outreachMailbox } from "@/lib/outreach-google";
export async function GET() {
  const admin=await requireAdminUser();
  if(process.env.VERCEL_ENV!=="production"||!googleOutreachConfigured())return NextResponse.redirect(new URL("/control-room/outreach?connection=setup",GOOGLE_CALLBACK));
  const state=randomBytes(32).toString("base64url"),verifier=randomBytes(48).toString("base64url");
  await getDb().execute(sql`DELETE FROM outreach_oauth_states WHERE expires_at<now()`);
  await getDb().execute(sql`INSERT INTO outreach_oauth_states(state_hash,admin_id,verifier,expires_at) VALUES(${createHash("sha256").update(state).digest("hex")},${admin.id}::uuid,${verifier},now()+interval '10 minutes')`);
  (await cookies()).set("outreach_oauth",state,{httpOnly:true,secure:true,sameSite:"lax",path:"/api/outreach/google",maxAge:600});
  const url=new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search=new URLSearchParams({client_id:process.env.OUTREACH_GOOGLE_CLIENT_ID!,redirect_uri:GOOGLE_CALLBACK,response_type:"code",scope:GOOGLE_SCOPES.join(" "),state,access_type:"offline",prompt:"consent",login_hint:outreachMailbox(),code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"}).toString();
  return NextResponse.redirect(url);
}
