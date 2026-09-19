export const OUTREACH_ORIGIN = "https://www.sendascout.com";
export const segments = { property: "Property businesses", vehicle: "Vehicle buyers & dealers", project: "Contractors & projects", purchase: "Equipment & item buyers", custom: "Other businesses" } as const;
export type Segment = keyof typeof segments;
export type ProspectInput = { company:string; contactName:string; email:string; website:string; segment:Segment; location:string; researchNote:string; sourceUrl:string; notes:string; permission:"research_only"|"requested"|"opt_in"; permissionNote:string };
export function normalizeEmail(value:string) {
  const email=value.trim().toLowerCase();
  if(email.length>254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) throw new Error("Enter a valid email address.");
  return email;
}
export function safeWebsite(value:string) {
  if(!value.trim()) return "";
  let url:URL; try { url=new URL(value.trim()); } catch { throw new Error("Use a full https:// website address."); }
  if(url.protocol!=="https:" || url.username || url.password) throw new Error("Use a secure https:// website address.");
  return url.toString();
}
export function prospectInput(data:Record<string,string>):ProspectInput {
  const get=(key:string,max:number)=>String(data[key]??"").trim().slice(0,max);
  const segment=get("segment",30); if(!Object.hasOwn(segments,segment)) throw new Error("Choose a business type.");
  const company=get("company",200);if(!company)throw new Error("Add the business name.");
  const permission=get("permission",30)||"research_only";
  if(!["research_only","requested","opt_in"].includes(permission))throw new Error("Choose a contact permission status.");
  const permissionNote=get("permissionNote",1000);
  if(permission!=="research_only" && permissionNote.length<10)throw new Error("Record when and how this person requested information or gave permission.");
  return {company,contactName:get("contactName",160),email:normalizeEmail(get("email",300)),website:safeWebsite(get("website",1000)),segment:segment as Segment,location:get("location",200),researchNote:get("researchNote",1500),sourceUrl:safeWebsite(get("sourceUrl",1000)),notes:get("notes",4000),permission:permission as ProspectInput["permission"],permissionNote};
}
const offers:Record<Segment,{subject:string;pitch:string;path:string}>={
  property:{subject:"Current photos of a property you can't get to",pitch:"When you need eyes on a distant rental, vacant property, or completed contractor job, Send a Scout can help document what is there. Property Checks start at $39 and bring current photos, observations, and a downloadable PDF report together.",path:"property-check"},
  vehicle:{subject:"Need current photos of a vehicle out of town?",pitch:"Send a Scout can arrange current photos, a visual walkaround, VIN and displayed mileage documentation before you travel or buy remotely. Vehicle Checks start at $49. This is visual documentation, not a mechanical inspection; seller access must be arranged.",path:"vehicle-check"},
  project:{subject:"Photos of the work without another site visit",pitch:"Send a Scout can document progress or completed work at a distant job site with current photos, written observations, and a PDF report. Project Checks start at $39, with your specific areas of interest included in the checklist.",path:"project-check"},
  purchase:{subject:"Put eyes on an item before making the trip",pitch:"Send a Scout can document an item's presence and visible condition, identifying labels, and the details you request before you travel for a purchase. Purchase Verification starts at $39. Seller permission and access are needed; this is not an appraisal or performance guarantee.",path:"purchase-verification"},
  custom:{subject:"A local set of eyes for your next remote check",pitch:"Send a Scout helps document something you cannot see in person. Tell us what needs photographing or answering at one location and receive organized findings in a PDF report. Custom Photo / Video Checks start at $39.",path:"custom"},
};
export function tailoredDraft(p:Pick<ProspectInput,"company"|"contactName"|"segment"|"researchNote">,followup=false) {
  const offer=offers[p.segment];const greeting=p.contactName?`Hi ${p.contactName},`:`Hi ${p.company} team,`;
  return {subject:followup?`Following up: ${offer.subject}`:offer.subject,body:[greeting,followup?"Following up on the Send a Scout information I shared. Do you have a location you would like documented?":p.researchNote||`I'm reaching out with a possible use for Send a Scout at ${p.company}.`,offer.pitch,`Standard checks target completion within 72 hours; Scout availability and access vary by location. No subscription is required.\n\nDetails: ${OUTREACH_ORIGIN}/${offer.path}`,"Do you have one location you would like us to check?","Kyle\nSend a Scout"].join("\n\n")};
}
// RFC 4180-style quoting, bounded import. Imports never grant sending permission.
export function parseProspectCsv(csv:string):ProspectInput[] {
  if(csv.length>200000)throw new Error("Import at most 200 KB at a time.");
  const rows:string[][]=[];let row:string[]=[];let cell="";let quoted=false;
  const input=csv.replace(/^\uFEFF/,"");
  for(let i=0;i<input.length;i++) {const c=input[i];if(c==='"'){if(quoted&&input[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===","||c==="\n")){row.push(cell.replace(/\r$/,""));cell="";if(c==="\n"){rows.push(row);row=[];}}else cell+=c;}
  if(quoted)throw new Error("CSV contains an unfinished quoted field.");
  if(cell||row.length){row.push(cell.replace(/\r$/,""));rows.push(row);}
  const header=rows.shift()?.map(s=>s.trim());if(!header?.includes("company")||!header.includes("email"))throw new Error("CSV needs company and email columns.");
  const data=rows.filter(r=>r.some(v=>v.trim()));if(data.length>100)throw new Error("Import up to 100 prospects at a time.");
  const seen=new Set<string>();return data.map((values,index)=>{try{const p=prospectInput({...Object.fromEntries(header.map((h,i)=>[h,values[i]??""])),segment:values[header.indexOf("segment")]||"property",permission:"research_only",permissionNote:""});if(seen.has(p.email))throw new Error("Duplicate email in this file.");seen.add(p.email);return p;}catch(e){throw new Error(`Row ${index+2}: ${e instanceof Error?e.message:"Invalid prospect"}`);}});
}
export function businessHours(now=new Date()) {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",hour:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const day=parts.find(p=>p.type==="weekday")?.value;const hour=Number(parts.find(p=>p.type==="hour")?.value);
  return day!=="Sat"&&day!=="Sun"&&hour>=9&&hour<17;
}
