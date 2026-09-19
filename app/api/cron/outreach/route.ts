import { runOutreachWorker } from "@/lib/outreach-worker";
export const maxDuration=300;
export async function GET(request:Request) {
  if(!process.env.CRON_SECRET||request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)return new Response("Unauthorized",{status:401});
  const result=await runOutreachWorker();console.info("Outreach job finished",result);return Response.json(result);
}
