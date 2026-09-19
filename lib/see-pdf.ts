import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, PDFName, PDFString, type PDFPage, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { SeeReportSnapshot } from "./see-report-types";

const navy = rgb(.031, .169, .271), teal = rgb(.21, .43, .37), grey = rgb(.34, .41, .44), pale = rgb(.93, .96, .94), line = rgb(.83, .88, .85);
export async function buildSeePdf(snapshot: SeeReportSnapshot, loadPhoto: (filePath: string) => Promise<Uint8Array>) {
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([readFile(path.join(process.cwd(), "assets/fonts/DejaVuSans.ttf")), readFile(path.join(process.cwd(), "assets/fonts/DejaVuSans-Bold.ttf"))]);
  const font = await pdf.embedFont(regularBytes, { subset: true }); const bold = await pdf.embedFont(boldBytes, { subset: true });
  pdf.setTitle(`${snapshot.templateName} — ${snapshot.missionId}`); pdf.setAuthor("Send a Scout"); pdf.setSubject("On-location visual documentation");
  let page!: PDFPage; let y = 0; const margin = 46; const width = 520;
  const missionLabel = snapshot.sample ? "SAMPLE REPORT · ILLUSTRATIVE DATA" : `MISSION ${snapshot.missionId.slice(0,8).toUpperCase()} · REVISION ${snapshot.revision}`;
  function newPage() {
    page = pdf.addPage([612,792]); y = 678;
    page.drawRectangle({x:0,y:724,width:612,height:68,color:navy});
    page.drawText("Send a Scout", { x:margin,y:752,size:18,font:bold,color:rgb(1,1,1) });
    page.drawText("YOUR EYES ON LOCATION", {x:margin,y:736,size:6.5,font,color:rgb(.69,.83,.78)});
    page.drawText(missionLabel, {x:margin,y:709,size:7,font,color:grey});
  }
  function space(height:number) { if (y-height < 64) newPage(); }
  function wrap(text:string, size:number, maxWidth:number, face:PDFFont) {
    const lines:string[]=[];
    for (const paragraph of String(text || "").replace(/\r/g, "").split("\n")) {
      let current="";
      for (const word of paragraph.split(/\s+/)) {
        if (!word) continue;
        if (face.widthOfTextAtSize(word,size)>maxWidth) {
          if(current) {lines.push(current);current="";}
          for (const char of Array.from(word)) { if(face.widthOfTextAtSize(current+char,size)>maxWidth) {lines.push(current);current="";} current+=char; }
        } else if (current && face.widthOfTextAtSize(`${current} ${word}`,size)>maxWidth) { lines.push(current);current=word; }
        else current += (current ? " " : "") + word;
      }
      lines.push(current);
    }
    return lines;
  }
  function text(value:string,size=10,face=font,color=grey,indent=0) { for (const row of wrap(value,size,width-indent,face)) { space(size*1.6);page.drawText(row,{x:margin+indent,y,size,font:face,color});y-=size*1.6; } }
  function heading(value:string) { space(120); y-=17;text(value,15,bold,navy); y-=4; }
  function rule() {space(18);page.drawLine({start:{x:margin,y},end:{x:566,y},thickness:.6,color:line}); y-=16;}
  function when(value:string|null) {return value ? new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short",timeZone:snapshot.timeZone}).format(new Date(value)) : "Not recorded";}
  newPage(); text(`${snapshot.templateName} Report`,25,bold,navy); y-=8; text(snapshot.address,11,bold,navy); y-=8;
  text(`Visit: ${when(snapshot.visitAt)} · ${snapshot.timeZone}`,9);text(`Submitted: ${when(snapshot.submittedAt)}`,9);text(`Scout: ${snapshot.scoutName} · ID ${snapshot.scoutId.slice(0,8).toUpperCase()}`,9);y-=9;rule();
  if(snapshot.sample){text("This is an example using fictional details and illustrations. It is not evidence of a real visit.",10,bold,teal);y-=10;}
  heading("Requested check");text(snapshot.title,11,bold,navy);if(snapshot.requestedFocus)text(snapshot.requestedFocus);
  heading("Scout observations");text(snapshot.summary || "See the individual checklist observations below.");
  const limitations = snapshot.items.filter(item=>item.unavailableReason);
  heading("Evidence at a glance");const photos = snapshot.items.flatMap(item=>item.files).filter(file=>file.contentType.startsWith("image/"));const videos = snapshot.items.flatMap(item=>item.files).filter(file=>file.contentType.startsWith("video/"));
  text(`${photos.length} photos · ${videos.length} videos · ${snapshot.items.length-limitations.length} documented checklist items · ${limitations.length} access / evidence limitations`,10,bold,teal);
  text(snapshot.locationVerified ? "Check-in location was verified using device location at the visit. This does not independently verify the location or capture time of each uploaded file." : "Visit location was not independently verified. Uploaded media may contain device-reported times; those are not proof of capture time.",9);
  if(snapshot.locationVerified && snapshot.latitude && snapshot.longitude) text(`Check-in: ${snapshot.latitude}, ${snapshot.longitude}${snapshot.accuracyMeters ? ` · reported accuracy ${snapshot.accuracyMeters} m` : ""}`,8);
  if(limitations.length){heading("What could not be checked");for(const item of limitations){text(item.prompt,10,bold,navy);text(item.unavailableReason);y-=7;}}
  heading("Written answers");for(const item of snapshot.items.filter(item=>item.text)){space(70);text(item.prompt,10,bold,navy);text(item.text);y-=10;}
  if(photos.length){space(330);heading("Photographic record");y-=8;}
  let photoNumber=0;
  for(const item of snapshot.items){for(const file of item.files.filter(file=>file.contentType.startsWith("image/"))){
    const img=await pdf.embedJpg(await loadPhoto(file.path));const dims=img.scaleToFit(520,205);const caption=`${++photoNumber}. ${item.prompt}`;const captionLines=wrap(caption,11,width,bold);const blockHeight=dims.height+captionLines.length*18+50;space(blockHeight);
    text(caption,11,bold,navy);y-=7;page.drawRectangle({x:margin,y:y-dims.height,width:520,height:dims.height,color:pale});page.drawImage(img,{x:margin+(520-dims.width)/2,y:y-dims.height,width:dims.width,height:dims.height});y-=dims.height+15;
    text(`Uploaded: ${when(file.uploadedAt)}${file.deviceTimestamp ? ` · Device file time: ${when(file.deviceTimestamp)} (unverified)` : ""}`,7);y-=16;
  }}
  if(videos.length){heading("Video record");for(const item of snapshot.items){const files=item.files.filter(file=>file.contentType.startsWith("video/"));if(files.length){text(`${item.prompt} · ${files.length} video${files.length>1?"s":""}`,10,bold,navy);text("View the original video in your private mission page.",9);}}}
  heading("Your online report");text(snapshot.sample ? "Your actual report links to the original photos and videos in your Send a Scout account." : "Open the mission to view original media, video, and the latest report. Sign-in is required. This PDF can be shared separately with people you choose.",9);
  if(!snapshot.sample){space(35);const url=`https://www.sendascout.com/dashboard/missions/${snapshot.missionId}`;const linkY=y; text("Open mission photos and video →",11,bold,teal);const annotation=pdf.context.obj({Type:"Annot",Subtype:"Link",Rect:[margin,linkY-5,360,linkY+14],Border:[0,0,0],A:{Type:"Action",S:"URI",URI:PDFString.of(url)}});page.node.set(PDFName.of("Annots"),pdf.context.obj([pdf.context.register(annotation)]));}
  heading("Scope and limitations");text("This report records a Scout’s observations and uploaded evidence at one visit. It is not a professional inspection, mechanical diagnosis, appraisal, engineering opinion, insurance assessment, or guarantee of a seller, item, or future condition. Areas that were inaccessible, unsafe, or outside the requested scope were not checked. Video remains available through the private online mission; video is not embedded in this PDF.",8);
  const pages=pdf.getPages();pages.forEach((p,index)=>{p.drawLine({start:{x:margin,y:47},end:{x:566,y:47},thickness:.6,color:line});p.drawText(snapshot.sample?"EXAMPLE ONLY · FICTIONAL DETAILS":"PRIVATE CUSTOMER REPORT · SHARE WITH CARE",{x:margin,y:33,size:6.5,font,color:grey});p.drawText(`${index+1} / ${pages.length}`,{x:535,y:33,size:8,font,color:grey});});
  return pdf.save();
}
