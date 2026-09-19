import { NextResponse } from "next/server";
import { runSeeFulfillment } from "@/lib/see-fulfillment";
import { reconcileSeeReports } from "@/lib/see-reports";
import { reconcilePendingBookingPayments } from "@/lib/stripe-payment-reconciliation";
export const maxDuration=300;
export async function GET(request:Request){
 if(!process.env.CRON_SECRET || request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`)return new NextResponse("Unauthorized",{status:401});
 const results:Record<string,unknown>={};let failed=false;
 for(const [name,operation] of [["payments",reconcilePendingBookingPayments],["fulfillment",runSeeFulfillment],["reports",reconcileSeeReports]] as const){try{results[name]=await operation();}catch(error){failed=true;console.error(`See It ${name} worker failed`,error);results[name]={error:"Worker failed; retry required"};}}
 return NextResponse.json(results,{status:failed?500:200});
}
