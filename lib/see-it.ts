/** The immutable product contract shared by ordering, fieldwork and reports. */
export type SeeTemplateKey = "property" | "vehicle" | "purchase" | "project" | "custom";
export type SeeTask = { key: string; prompt: string; responseType: "photo" | "video" | "text"; guidance: string };
export type SeeTemplate = {
  key: SeeTemplateKey; slug: string; name: string; shortName: string; description: string;
  priceCents: number; scoutCents: number; capCents: number; minutes: string;
  maxPhotos: number; maxVideos: number; tasks: SeeTask[]; examples: string[];
};
const photo = (key: string, prompt: string, guidance = "Take a clear current photo. Add a closer view if needed."): SeeTask => ({ key, prompt, responseType: "photo", guidance });
const question = (key: string, prompt: string, guidance = "Describe only what you observed. Say if you cannot determine the answer."): SeeTask => ({ key, prompt, responseType: "text", guidance });
const video = (key: string, prompt: string, guidance = "Record a steady, short video. Only enter areas or operate items with permission."): SeeTask => ({ key, prompt, responseType: "video", guidance });
export const SEE_TEMPLATE_VERSION = 1;
export const SEE_TEMPLATES: SeeTemplate[] = [
  { key: "property", slug: "property-check", name: "Property Check", shortName: "A property", description: "See a home, rental, yard or investment property without making the trip.", priceCents: 3900, scoutCents: 2200, capCents: 3400, minutes: "20-30", maxPhotos: 15, maxVideos: 1,
    examples: ["Check a vacant property", "See whether the yard was maintained", "Document visible storm damage"], tasks: [
      photo("address", "Street number / property identifier"), photo("front", "Front of property"), photo("street", "Street and surrounding context"),
      photo("left", "Left side", "Photograph from an accessible, permitted area."), photo("right", "Right side", "Photograph from an accessible, permitted area."),
      photo("rear", "Rear of property", "Only if accessible with permission. Otherwise record the access limitation."), photo("grounds", "Yard and grounds"),
      photo("concerns", "Requested areas and visible concerns", "Include context and close-ups. If no concern is visible, show the requested area as observed."),
      video("walkaround", "Short exterior walkaround"), question("condition", "What visible condition or maintenance issues did you observe?"), question("access", "Which areas could you access, and what could not be checked?"),
    ] },
  { key: "vehicle", slug: "vehicle-check", name: "Vehicle Check", shortName: "A vehicle", description: "Get current photos, VIN, displayed mileage and a detailed visual walkaround.", priceCents: 4900, scoutCents: 2800, capCents: 4400, minutes: "30-45", maxPhotos: 24, maxVideos: 2,
    examples: ["Review out-of-town inventory", "See a private-sale vehicle", "Check a vehicle before traveling"], tasks: [
      photo("vin", "VIN plate / vehicle identifier"), photo("odometer", "Odometer and dashboard", "Show displayed mileage and warning lights; only ask an authorized person to turn on the ignition."),
      photo("front-left", "Front left exterior"), photo("front-right", "Front right exterior"), photo("rear-left", "Rear left exterior"), photo("rear-right", "Rear right exterior"),
      photo("left", "Driver side"), photo("right", "Passenger side"), photo("wheels", "Each wheel and tire", "Add one clear photo of each wheel/tire."),
      photo("front-seats", "Front seats and controls"), photo("rear-seats", "Rear seats"), photo("headliner", "Headliner"), photo("cargo", "Trunk / cargo area"),
      photo("engine", "Engine bay", "Ask an authorized person to open it. No mechanical work or diagnosis."), photo("concerns", "Visible damage and requested details"),
      video("walkaround", "Exterior walkaround video"), video("start", "Seller-performed start, if permitted", "Record the seller starting it. Do not claim a cold start unless established; no test drive."),
      question("identity", "What VIN and mileage / units were displayed?"), question("condition", "What visible damage or warning lights did you observe?"), question("access", "What could not be checked, and why?"),
    ] },
  { key: "purchase", slug: "purchase-verification", name: "Purchase Verification", shortName: "An item", description: "Have someone put eyes on an item and document its visible condition before you travel.", priceCents: 3900, scoutCents: 2200, capCents: 3400, minutes: "20-30", maxPhotos: 15, maxVideos: 1,
    examples: ["View used equipment", "Document a Marketplace find", "See model and serial numbers"], tasks: [
      photo("overview", "Whole item and location context"), photo("front", "Front of item"), photo("sides", "Sides and rear"), photo("identifier", "Model / serial number plate"),
      photo("accessories", "Included accessories and parts"), photo("details", "Visible condition and requested details"), video("demo", "Seller demonstration or item walkaround", "A permitted seller demonstration documents what was shown, not future reliability."),
      question("identity", "What item and identifiers did you observe?"), question("condition", "What condition, parts and demonstration did you observe?"), question("limitations", "What could not be confirmed?"),
    ] },
  { key: "project", slug: "project-check", name: "Project Check", shortName: "A project", description: "See progress or completed work when you cannot be there yourself.", priceCents: 3900, scoutCents: 2200, capCents: 3400, minutes: "20-30", maxPhotos: 15, maxVideos: 1,
    examples: ["Document contractor progress", "See a completed repair", "Check maintenance work"], tasks: [
      photo("location", "Location identifier and overview"), photo("work", "Each requested work area", "Use the customer's stated milestones and photograph each requested area."),
      photo("details", "Close-up details of the work"), photo("unfinished", "Visible unfinished areas / concerns", "If none are apparent, show the requested area as observed."),
      video("walkthrough", "Short project walkthrough"), question("progress", "What work was visibly present at the visit?"), question("differences", "What differences did you observe from the requested scope?"), question("access", "What areas or work could not be checked?"),
    ] },
  { key: "custom", slug: "custom", name: "Custom Photo / Video Check", shortName: "Something else", description: "Tell a Scout exactly what you need photographed, recorded or answered at one location.", priceCents: 3900, scoutCents: 2200, capCents: 3400, minutes: "20-30", maxPhotos: 15, maxVideos: 1,
    examples: ["Check a business sign", "Document a location", "Answer a specific on-site question"], tasks: [
      photo("location", "Location / subject identifier"), photo("overview", "Overview of the requested subject"), photo("details", "Customer-requested details", "Follow the private assignment instructions and add a photo for each requested detail."),
      video("overview-video", "Short video of the requested subject"), question("observations", "What did you observe?"), question("limitations", "What could not be checked, and why?"),
    ] },
];
export function getSeeTemplate(key: string | null | undefined) { return SEE_TEMPLATES.find((item) => item.key === key || item.slug === key); }
export type SeeConfiguration = {
  templateKey: SeeTemplateKey; subject: string; focus: string; access: "public" | "permission";
  accessInstructions: string; visitHours: string; earliestVisit: string; completeBy: string;
  serviceLevel: "standard" | "priority"; extraQuestions: string[]; accessConfirmed: boolean;
};
export type SeeSnapshot = { version: number; template: SeeTemplate; configuration: SeeConfiguration };
export function normalizeSeeConfiguration(raw: SeeConfiguration): SeeConfiguration {
  const template = getSeeTemplate(raw?.templateKey);
  if (!template) throw new Error("Choose a valid See It check.");
  const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const config: SeeConfiguration = {
    templateKey: template.key, subject: text(raw.subject, 120), focus: text(raw.focus, 2000),
    access: raw.access === "permission" ? "permission" : "public", accessInstructions: text(raw.accessInstructions, 1500),
    visitHours: text(raw.visitHours, 250), earliestVisit: text(raw.earliestVisit, 40), completeBy: text(raw.completeBy, 40),
    serviceLevel: raw.serviceLevel === "priority" ? "priority" : "standard",
    extraQuestions: Array.isArray(raw.extraQuestions) ? raw.extraQuestions.map((q) => text(q, 180)).filter(Boolean) : [],
    accessConfirmed: raw.accessConfirmed === true,
  };
  if (!config.subject) throw new Error("Describe the property, vehicle, item or project.");
  if (!config.accessConfirmed) throw new Error("Confirm that the requested visit and access are permitted.");
  if (config.extraQuestions.length > 5) throw new Error("Standard checks include up to five additional questions.");
  if (template.key === "custom" && config.focus.length < 10) throw new Error("Describe exactly what your Scout should document.");
  if (["vehicle", "purchase"].includes(template.key) && (config.access !== "permission" || config.accessInstructions.length < 10)) throw new Error("Add seller or location access arrangements before requesting this check.");
  return config;
}
export function seeChecklist(config: SeeConfiguration): SeeTask[] {
  const template = getSeeTemplate(config.templateKey);
  if (!template) throw new Error("Unknown See It template.");
  return [...template.tasks, ...config.extraQuestions.map((prompt, index) => question(`custom-${index + 1}`, prompt))];
}
export function seePrice(config: Pick<SeeConfiguration, "templateKey" | "serviceLevel">) {
  const template = getSeeTemplate(config.templateKey);
  if (!template) throw new Error("Unknown See It template.");
  const priority = config.serviceLevel === "priority";
  return { customer: template.priceCents + (priority ? 2000 : 0), scout: template.scoutCents + (priority ? 1000 : 0), cap: template.capCents + (priority ? 2000 : 0), hours: priority ? 24 : 72 };
}
export function seeOfferAt(input: { baseCents: number; capCents: number; currentCents: number; fundedAt: Date; deadline: Date; now: Date }) {
  const window = input.deadline.getTime() - input.fundedAt.getTime();
  if (window <= 0 || input.now >= input.deadline) return input.currentCents;
  const elapsed = (input.now.getTime() - input.fundedAt.getTime()) / window;
  const step = elapsed >= 5 / 6 ? 3 : elapsed >= 2 / 3 ? 2 : elapsed >= 1 / 3 ? 1 : 0;
  const target = Math.min(input.capCents, input.baseCents + step * 400);
  return Math.max(input.currentCents, target);
}
export const SEE_UNAVAILABLE_REASONS = ["Access restricted", "Not present / not visible", "Unsafe to capture", "Seller unavailable", "Not applicable"] as const;
export function seeResultComplete(input: { responseType: string; responseText?: string; photoCount: number; videoCount: number; unavailableReason?: string }) {
  if (input.unavailableReason) return input.unavailableReason.trim().length >= 10 && input.unavailableReason.trim().length <= 500;
  if (input.responseType === "photo") return input.photoCount > 0;
  if (input.responseType === "video") return input.videoCount > 0;
  return Boolean(input.responseText?.trim());
}
export function safeLocalReturn(value: unknown, fallback = "/dashboard") {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\r\n]/.test(value) ? value : fallback;
}
export function seeAlertRadius(fundedAt: Date | null, deadline: Date | null, now = new Date()) {
  if (!fundedAt || !deadline) return 10;
  const fraction = (now.getTime() - fundedAt.getTime()) / Math.max(1, deadline.getTime() - fundedAt.getTime());
  return fraction >= 2 / 3 ? 50 : fraction >= 1 / 3 ? 25 : 10;
}
