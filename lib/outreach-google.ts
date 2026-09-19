import "server-only";
import { decryptOutreachToken } from "@/lib/outreach-mail";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.readonly"];
export const GOOGLE_CALLBACK = "https://www.sendascout.com/api/outreach/google/callback";
export const outreachMailbox = () => (process.env.OUTREACH_GOOGLE_MAILBOX || "support@sendascout.com").toLowerCase();
export function googleOutreachConfigured() {
  return Boolean(process.env.OUTREACH_GOOGLE_CLIENT_ID&&process.env.OUTREACH_GOOGLE_CLIENT_SECRET&&/^[a-f0-9]{64}$/i.test(process.env.OUTREACH_TOKEN_KEY||""));
}
export async function googleToken(parameters:Record<string,string>) {
  if(!googleOutreachConfigured())throw new Error("Google Workspace connection setup is required.");
  const response=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...parameters,client_id:process.env.OUTREACH_GOOGLE_CLIENT_ID!,client_secret:process.env.OUTREACH_GOOGLE_CLIENT_SECRET!}),signal:AbortSignal.timeout(15000),cache:"no-store"});
  const data=await response.json() as {access_token?:string;refresh_token?:string;scope?:string};
  if(!response.ok||!data.access_token)throw new Error("Google could not authorize this mailbox. Reconnect Google Workspace.");
  return data as {access_token:string;refresh_token?:string;scope?:string};
}
export async function outreachAccessToken(encrypted:string) {
  const refresh=decryptOutreachToken(encrypted,process.env.OUTREACH_TOKEN_KEY!);
  return (await googleToken({grant_type:"refresh_token",refresh_token:refresh})).access_token;
}
export async function gmailRequest<T>(access:string,path:string,body?:unknown):Promise<T> {
  if(!path.startsWith("/")||path.startsWith("//"))throw new Error("Invalid Gmail request.");
  const response=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`,{method:body?"POST":"GET",headers:{Authorization:`Bearer ${access}`,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),cache:"no-store"});
  if(!response.ok)throw new Error(`Google Workspace request failed (HTTP ${response.status}).`);
  return await response.json() as T;
}
