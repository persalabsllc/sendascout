export const SCOUT_HANDBOOK_VERSION = "2026-09-01-v1";
export const SCOUT_HANDBOOK_EFFECTIVE_DATE = "September 1, 2026";
export const SCOUT_HANDBOOK_EFFECTIVE_DATE_ISO = "2026-09-01";

export type ScoutHandbookProfileAcceptance = {
  handbookVersion: string | null;
  handbookAcceptedAt: Date | string | null;
};

export type ScoutHandbookCallout = {
  title: string;
  body: string;
  tone: "info" | "safety";
};

export type ScoutHandbookSection = {
  id: string;
  title: string;
  paragraphs?: readonly string[];
  bullets?: readonly string[];
  steps?: readonly string[];
  callout?: ScoutHandbookCallout;
};

export type ScoutHandbookPrinciple = {
  title: string;
  text: string;
};

export function hasCurrentScoutHandbookAcceptance(
  profile: ScoutHandbookProfileAcceptance | null | undefined,
) {
  return Boolean(profile?.handbookAcceptedAt)
    && profile?.handbookVersion === SCOUT_HANDBOOK_VERSION;
}

export const SCOUT_HANDBOOK_PRINCIPLES = [
  { title: "Respect people", text: "Be polite, calm, fair, and professional." },
  { title: "Protect privacy", text: "Access and record only what the mission requires." },
  { title: "Care for property", text: "Handle every location and item with respect." },
  { title: "Stay honest", text: "Keep updates, evidence, and reports accurate." },
  { title: "Choose safety", text: "Stop when a mission becomes unsafe or unlawful." },
] as const satisfies readonly ScoutHandbookPrinciple[];

export const SCOUT_HANDBOOK_SECTIONS: readonly ScoutHandbookSection[] = [
  {
    id: "independent-work",
    title: "Your choice and responsibility",
    paragraphs: [
      "Scouts use Send a Scout as independent contractors. You decide whether to use the platform, when you are available, which missions to accept, and the lawful and safe route, tools, vehicle, and method used to produce the requested result.",
      "There are no required shifts, minimum hours, guaranteed missions, or guaranteed earnings. You may provide services to other businesses or customers. You are responsible for your expenses, equipment, transportation, licenses, insurance, taxes, and compliance with applicable law.",
      "When you accept a mission, you agree to deliver its stated result within the accepted location, time window, and customer requirements. Only the verified Scout who accepted a mission may perform it. Never share your account or let another person complete a mission under your identity.",
    ],
  },
  {
    id: "scout-standard",
    title: "The Scout standard",
    paragraphs: ["Every mission should leave the customer feeling that their request, property, and trust were handled well."],
    bullets: [
      "Be honest, respectful, dependable, and courteous.",
      "Treat every person and property with care.",
      "Follow the agreed mission scope and all applicable laws.",
      "Provide accurate updates, reports, receipts, and evidence.",
      "Never claim work was performed when it was not.",
      "Never falsify a location, time, photograph, delivery, signature, PIN, receipt, or report.",
      "Do not make promises or commitments on behalf of Send a Scout.",
    ],
  },
  {
    id: "customer-interaction",
    title: "Customer interaction",
    paragraphs: ["Keep every interaction polite, calm, and focused on the accepted mission."],
    bullets: [
      "Identify yourself as the Scout completing the mission and communicate clearly.",
      "Respect personal boundaries, cultural differences, and lawful accessibility needs.",
      "Do not discriminate, harass, threaten, intimidate, insult, argue with, or make unwanted comments toward anyone.",
      "Do not request tips, gifts, dates, favors, personal contact information, or future off-platform work.",
      "Do not smoke, vape, consume alcohol, use illegal drugs, or perform a mission while impaired.",
      "If a disagreement occurs, do not escalate it. Step away when safe and contact Support.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy and no snooping",
    paragraphs: ["A mission never gives you general permission to explore a customer's property. Use customer information only to complete the accepted mission or resolve its support issue."],
    bullets: [
      "Enter only locations expressly authorized by the customer and reasonably necessary for the mission.",
      "Stay within the authorized mission area.",
      "Do not open drawers, cabinets, closets, doors, packages, mail, containers, computers, phones, files, or personal records unless the mission specifically and lawfully requires it.",
      "Do not touch, move, inspect, photograph, or record unrelated property.",
      "Do not search for valuables or personal information, listen to private conversations, or make unauthorized audio recordings.",
      "Never copy, save, sell, post, or share addresses, access codes, names, photographs, documents, or other private information.",
      "Never post mission details or customer property on social media.",
      "If you accidentally see sensitive information, do not copy or share it.",
    ],
  },
  {
    id: "property-deliveries",
    title: "Respect for property and deliveries",
    paragraphs: ["Handle every item as though it were your own. Do not use, borrow, sample, consume, replace, keep, or remove customer property except as expressly required by the mission."],
    bullets: [
      "Check an item's visible condition before taking possession and report existing damage.",
      "Do not open a sealed package unless the mission expressly requires and authorizes it.",
      "Secure items against preventable damage, loss, theft, contamination, smoke, pets, weather, spills, crushing, or movement.",
      "Do not leave an item unattended except at an authorized delivery location.",
      "Verify the delivery location or recipient before releasing an item.",
      "Use any required delivery PIN without recording or sharing it.",
      "Submit genuine proof of pickup or delivery when requested.",
      "Immediately report damage, loss, a missing item, an incorrect item, or a delivery problem.",
    ],
  },
  {
    id: "communication",
    title: "Mission scope and communication",
    paragraphs: ["Review the location, requested result, time window, item details, and payout before accepting. Accept only missions you believe you can complete lawfully and safely."],
    bullets: [
      "Provide truthful status updates and use Send a Scout messaging whenever available.",
      "Contact the customer only for information reasonably needed to complete the mission.",
      "Do not materially change the scope, price, destination, recipient, or requested result without documented customer approval and any required platform approval.",
      "Never collect an off-platform payment or move a platform mission off the platform.",
      "If you cannot complete a mission, notify the customer and Support as soon as safely possible. Do not disappear or leave the customer without an update.",
    ],
  },
  {
    id: "photos-data",
    title: "Photos, video, and mission data",
    paragraphs: ["Capture only the evidence reasonably required by the mission."],
    bullets: [
      "Avoid including unrelated people, children, private documents, screens, mail, access codes, or neighboring property.",
      "Do not photograph inside private areas beyond the authorized mission scope.",
      "Do not edit, stage, manipulate, reuse, or misrepresent mission evidence.",
      "Upload evidence through the approved platform process.",
      "Do not publish, sell, distribute, or use mission content for personal or commercial purposes.",
      "Delete customer media or information from your device when it is no longer needed for the mission or an active support matter.",
    ],
    callout: {
      title: "Protect the customer's privacy",
      body: "If a requested photo, video, or recording appears unsafe, invasive, or unlawful, stop and contact Support.",
      tone: "info",
    },
  },
  {
    id: "safety",
    title: "Safety",
    paragraphs: ["You are responsible for evaluating conditions and choosing a lawful, safe way to complete an accepted mission."],
    bullets: [
      "Do not enter or remain in a location that appears dangerous or unauthorized.",
      "Do not confront suspicious individuals, trespassers, aggressive animals, or anyone threatening you.",
      "Follow traffic laws and never use a handheld phone while operating a vehicle.",
      "Never drive or perform a mission while impaired, dangerously fatigued, or medically unable to do so safely.",
      "Use a vehicle and equipment legally suitable for the item being transported.",
      "Do not lift, carry, or move something beyond your safe ability or equipment capacity.",
      "Do not transport passengers, children, or animals as part of a mission.",
      "Do not enter a private residence when only an unaccompanied minor is present.",
    ],
    callout: {
      title: "Emergency first",
      body: "If there is immediate danger, injury, fire, suspected crime, or a medical emergency, move to safety and call 911 first. Contact Send a Scout Support after emergency help has been requested.",
      tone: "safety",
    },
  },
  {
    id: "prohibited-conduct",
    title: "Prohibited conduct",
    paragraphs: ["The following conduct may result in immediate loss of platform access:"],
    bullets: [
      "Theft, attempted theft, fraud, deliberate property damage, snooping, or unauthorized entry.",
      "Violence, threats, harassment, discrimination, sexual misconduct, or retaliation.",
      "Performing a mission while impaired.",
      "Account sharing, identity misrepresentation, or falsified mission evidence or status.",
      "Unauthorized purchases, charges, substitutions, or use of customer funds.",
      "Soliciting customers for off-platform services or payments.",
      "Carrying out an illegal, deceptive, clearly unsafe, or materially misrepresented request.",
      "Sharing or exploiting customer information, interfering with another Scout's mission, or keeping lost property.",
    ],
  },
  {
    id: "prohibited-missions",
    title: "Prohibited missions and items",
    paragraphs: ["Do not accept, purchase, possess, or transport through Send a Scout:"],
    bullets: [
      "Illegal, stolen, or fraudulently obtained property.",
      "Firearms, ammunition, explosives, fireworks, or weapons.",
      "Illegal drugs, cannabis products, controlled substances, or prescription medication.",
      "Alcohol, tobacco, nicotine, or vaping products.",
      "People or animals.",
      "Cash, gift cards, negotiable instruments, or financial-account access.",
      "Hazardous, toxic, infectious, radioactive, or dangerously flammable materials.",
      "Items requiring a license, permit, certification, age verification, or specialized handling not expressly supported by the platform.",
      "Anything exceeding the lawful or safe capacity of your vehicle or equipment.",
    ],
    callout: {
      title: "When a listing does not match",
      body: "If a mission appears prohibited or materially different from its listing, do not proceed. Contact Support.",
      tone: "safety",
    },
  },
  {
    id: "incidents",
    title: "Accidents, damage, and other incidents",
    paragraphs: ["If an accident, injury, threat, loss, suspected theft, property damage, or other serious incident occurs:"],
    steps: [
      "Move to safety and contact emergency services when appropriate.",
      "Notify Send a Scout Support as soon as safely possible.",
      "Provide an honest, factual description of what occurred.",
      "Preserve relevant messages, receipts, photographs, and other evidence.",
      "Do not alter evidence or pressure anyone to change their account.",
      "Do not speculate about fault, offer compensation, or make promises on behalf of Send a Scout.",
    ],
  },
  {
    id: "compliance",
    title: "Handbook compliance",
    paragraphs: [
      "Following this handbook is a condition of accessing missions through Send a Scout. Depending on the circumstances, violations may result in a warning, mission cancellation or reassignment, restricted access, suspension, deactivation, referral to law enforcement, or another action permitted by the platform Terms. Payment and dispute decisions are handled under the applicable Terms and mission records.",
      "The current handbook remains available in the Scout dashboard. If a material change is made, Scouts may be required to review and accept the updated version before viewing or accepting additional missions.",
    ],
  },
];

export const SCOUT_HANDBOOK_ACKNOWLEDGEMENT =
  `I confirm that I have read and understand the Send a Scout Handbook, Version ${SCOUT_HANDBOOK_VERSION}. I agree to follow it whenever I use the platform or perform a mission. I understand that I choose whether and which missions to accept as an independent contractor, and that I am responsible for selecting lawful and safe means, providing my own transportation and equipment, and handling my expenses, licenses, insurance, and taxes. I understand that violations may affect my access to the platform under the applicable Terms.`;
