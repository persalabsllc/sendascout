import { NextResponse } from "next/server";
import sharp from "sharp";
import { buildSeePdf } from "@/lib/see-pdf";
import { samplePropertySvg, sampleSeeReport } from "@/lib/see-sample-report";
export const runtime="nodejs";
export const maxDuration=60;
export async function GET(){const pdf=await buildSeePdf(sampleSeeReport,async kind=>sharp(Buffer.from(samplePropertySvg(kind))).jpeg({quality:85}).toBuffer());return new NextResponse(Buffer.from(pdf),{headers:{"Content-Type":"application/pdf","Content-Disposition":"inline; filename=Send-a-Scout-Sample-Report.pdf","Cache-Control":"public, max-age=3600","X-Content-Type-Options":"nosniff"}});}
