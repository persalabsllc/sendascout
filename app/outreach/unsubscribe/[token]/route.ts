import { getDb } from "@/db";
import { suppressOutreach } from "@/lib/outreach-sql";
const headers={"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Robots-Tag":"noindex, nofollow","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"};
export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}) {
  const {token}=await params;if(!/^[a-f0-9]{64}$/.test(token))return new Response("Invalid link",{status:400});
  // GET is a confirmation page, so security scanners cannot unsubscribe people.
  return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe | Send a Scout</title><body style="font:18px system-ui;max-width:600px;margin:70px auto;padding:24px;color:#17354a"><h1>Stop outreach emails</h1><p>Unsubscribe from Send a Scout sales outreach. Your mission, payment, and account notifications are unaffected.</p><form method="POST"><button style="padding:16px 24px;font:inherit;background:#17354a;color:white;border:0;border-radius:8px">Unsubscribe</button></form></body></html>',{headers});
}
export async function POST(_request:Request,{params}:{params:Promise<{token:string}>}) {
  const {token}=await params;if(!/^[a-f0-9]{64}$/.test(token))return new Response("Invalid link",{status:400});
  await getDb().execute(suppressOutreach(token));
  return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed | Send a Scout</title><body style="font:18px system-ui;max-width:600px;margin:70px auto;padding:24px;color:#17354a"><h1>You are unsubscribed.</h1><p>You will not receive further Send a Scout outreach emails. Mission and account notifications are unaffected.</p></body></html>',{headers});
}
