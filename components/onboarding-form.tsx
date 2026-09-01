"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { upload } from "@vercel/blob/client";
import { IconArrowLeft, IconArrowRight, IconCamera, IconCheck, IconCircleCheck, IconLock, IconPlus, IconTrash } from "@tabler/icons-react";
import { createMission, createScoutApplication, getMissionPriceQuote, type MissionCreationQuote, type MissionInput, type ScoutInput } from "@/app/actions/onboarding";
import { saveScoutHeadshot } from "@/app/actions/profile";
import { SCOUT_HANDBOOK_ACKNOWLEDGEMENT, SCOUT_HANDBOOK_VERSION } from "@/lib/scout-handbook";
import { formatDateTime, localDateTimeToUtc } from "@/lib/time";
import { defaultMissionTimeZoneForState, missionTimeZoneLabel, US_TIME_ZONE_OPTIONS } from "@/lib/us-time-zones";
import { Brand } from "./brand";
import { ScoutHandbookContent } from "./scout-handbook-content";

type Mode = "customer" | "scout";
const scoutSteps = ["You", "Area", "Setup", "Handbook", "Review"];

const emptyMission: MissionInput = {
  type: "see", address: "", addressLine2: "", city: "", state: "", zip: "",
  pickupName: "", pickupAddress: "", pickupAddressLine2: "", pickupCity: "", pickupState: "", pickupZip: "", pickupInstructions: "",
  dropoffName: "", dropoffAddress: "", dropoffAddressLine2: "", dropoffCity: "", dropoffState: "", dropoffZip: "", deliveryInstructions: "",
  largeItem: false, meetAuthorizedMinutes: 60, scheduledFor: "", timeZone: "America/New_York", title: "", instructions: "", phone: "",
  sourceMissionId: "", templateId: "", preferredScoutId: "", enhancedReport: false, checklistItems: [],
  saveAsTemplate: false, templateName: "", recurrence: "once", recurrenceEndsOn: "", recurrenceScheduleId: "", recurrenceOccurrenceAt: "",
  deliveryMethod: "leave_at_location", deliveryPinRequired: false, deliveryPin: "",
  addMoveLeg: false, bundleDropoffName: "", bundleDropoffAddress: "", bundleDropoffAddressLine2: "", bundleDropoffCity: "", bundleDropoffState: "", bundleDropoffZip: "", bundleDeliveryInstructions: "", bundleTitle: "", bundleInstructions: "", bundleLargeItem: false,
  bundleDeliveryMethod: "leave_at_location", bundleDeliveryPinRequired: false, bundleDeliveryPin: "",
};
const emptyScout: ScoutInput = { firstName: "", lastName: "", phone: "", homeZip: "", radius: 25, vehicleType: "", experience: "", canSee: true, canMove: true, canMeet: true, consent: false, smsNotificationsEnabled: false, handbookAccepted: false };

export type PreferredScoutOption = { id: string; firstName: string; completedMissions: number };

export function OnboardingForm({ mode, initialMissionType = "see", initialMissionAddress, initialPhone = "", initialMission, preferredScouts = [] }: { mode: Mode; initialMissionType?: MissionInput["type"]; initialMissionAddress?: Pick<MissionInput, "address" | "addressLine2" | "city" | "state" | "zip">; initialPhone?: string; initialMission?: Partial<MissionInput>; preferredScouts?: PreferredScoutOption[] }) {
  const { user } = useUser();
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const [quote, setQuote] = useState<MissionCreationQuote | null>(null);
  const [scoutHeadshot, setScoutHeadshot] = useState<File | null>(null);
  const profileState = initialMissionAddress?.state ?? "";
  const [mission, setMission] = useState<MissionInput>({
    ...emptyMission,
    ...initialMissionAddress,
    timeZone: defaultMissionTimeZoneForState(profileState),
    pickupState: profileState,
    dropoffAddress: initialMissionAddress?.address ?? "",
    dropoffAddressLine2: initialMissionAddress?.addressLine2 ?? "",
    dropoffCity: initialMissionAddress?.city ?? "",
    dropoffState: profileState,
    dropoffZip: initialMissionAddress?.zip ?? "",
    bundleDropoffState: profileState,
    phone: initialPhone,
    type: initialMissionType,
    ...initialMission,
    deliveryPin: "",
    bundleDeliveryPin: "",
  });
  const [scout, setScout] = useState<ScoutInput>({ ...emptyScout, firstName: user?.firstName ?? "", lastName: user?.lastName ?? "" });
  const customer = mode === "customer";
  const createdWithRecipientPin = customer && (
    (mission.type === "move" && mission.deliveryPinRequired)
    || (mission.addMoveLeg && mission.bundleDeliveryPinRequired)
  );
  const customerSteps = mission.type === "move" ? ["Mission", "Pickup", "Drop-off", "Item details", "Options", "Review"] : ["Mission", "Location", "Details", "Options", "Review"];
  const steps = customer ? customerSteps : scoutSteps;
  const customerHeading = mission.type === "move"
    ? ["What kind of mission?", "Where should the Scout pick it up?", "Where is it going?", "What should the Scout know?", "Choose delivery and repeat options", "Review your Move It mission"]
    : mission.type === "meet"
      ? ["What kind of mission?", "Where should the Scout meet or wait?", "Who are they meeting, and what should happen?", "Add reports, repeats or a delivery", "Review your Meet It mission"]
      : ["What kind of mission?", "Where should the Scout go?", "What should the Scout inspect?", "Choose report and repeat options", "Review your See It mission"];
  const heading = customer ? customerHeading : ["Let’s get to know you", "Where do you want to Scout?", "Set up your Scout profile", "Review the Scout Handbook", "Review your application"];

  function advance(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!customer && step >= 2 && !scoutHeadshot) {
      setError("Add a clear profile headshot before finishing your Scout application.");
      return;
    }
    if (!customer && step === 3 && !scout.handbookAccepted) {
      setError("Review the Scout Handbook and confirm your acknowledgment before continuing.");
      return;
    }
    if (step < steps.length - 1) {
      if (customer && step === steps.length - 2) {
        return startTransition(async () => {
          try {
            setQuote(await getMissionPriceQuote(mission));
            setStep((value) => value + 1);
          } catch (quoteError) {
            setError(quoteError instanceof Error ? quoteError.message : "We could not calculate this mission price. Please try again.");
          }
        });
      }
      return setStep((value) => value + 1);
    }
    startTransition(async () => {
      if (customer) {
        const result = await createMission(mission);
        if (result.ok && result.checkoutUrl) window.location.assign(result.checkoutUrl);
        else if (result.ok) setComplete(true);
        else setError(result.error);
        return;
      }

      const result = await createScoutApplication(scout);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!scoutHeadshot || !result.scoutUserId) {
        setError("Your application details were saved, but the required profile photo is still missing. Choose a photo and try again.");
        return;
      }
      try {
        const safeName = scoutHeadshot.name.replace(/[^a-zA-Z0-9._-]/g, "-");
        const blob = await upload(`scout-headshots/${result.scoutUserId}/${crypto.randomUUID()}-${safeName}`, scoutHeadshot, {
          access: "private",
          handleUploadUrl: "/api/scout-headshot/upload",
        });
        const saved = await saveScoutHeadshot(blob.pathname);
        if (!saved.ok) throw new Error(saved.error);
        setComplete(true);
      } catch (uploadError) {
        setError(uploadError instanceof Error
          ? `Your application details were saved, but the required photo did not finish: ${uploadError.message}`
          : "Your application details were saved, but the required photo did not finish uploading. Try again.");
      }
    });
  }

  function chooseScoutHeadshot(file: File | null) {
    setError("");
    if (!file) {
      setScoutHeadshot(null);
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setScoutHeadshot(null);
      setError("Choose a JPG, PNG, or WEBP profile photo.");
      return;
    }
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      setScoutHeadshot(null);
      setError("Choose a profile photo smaller than 5 MB.");
      return;
    }
    setScoutHeadshot(file);
  }

  if (complete) return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure onboarding</span></header>
      <section className="success-card">
        <span className="success-icon"><IconCircleCheck size={48} /></span>
        <span className="kicker">{customer ? "Payment received" : "Application received"}</span>
        <h1>{customer ? "Your mission is being released to eligible Scouts." : "Welcome to the Scout network."}</h1>
        <p>{customer ? "Stripe confirmed your payment. Matching Scouts in the selected service area can review and claim the mission as soon as publication finishes." : "Your founding Scout profile is saved. We’ll notify you when nearby mission opportunities match your service area."}</p>
        {createdWithRecipientPin && <div className="success-pin-reminder" role="note"><IconLock size={20} /><div><strong>Recipient PIN confirmation is active.</strong><span>Make sure you saved the PIN and shared it privately with the recipient. For security, it cannot be viewed or recovered after publishing.</span></div></div>}
        <Link className="button" href={customer ? "/dashboard/customer" : "/dashboard/scout"}>Open dashboard <IconArrowRight size={19} /></Link>
      </section>
    </main>
  );

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure onboarding</span></header>
      <section className="onboarding-shell">
        <aside className="progress-panel">
          <Link href="/" className="back-home"><IconArrowLeft size={18} /> Back home</Link>
          <span className="kicker light">{customer ? "Send a Scout" : "Become a Scout"}</span>
          <h2>{customer ? "Let’s build your mission." : "Do work worth leaving the house for."}</h2>
          <ol>{steps.map((label, index) => <li className={index === step ? "current" : index < step ? "done" : ""} key={label}><span>{index < step ? <IconCheck size={16} /> : index + 1}</span><div><small>Step {index + 1}</small><strong>{label}</strong></div></li>)}</ol>
        </aside>
        <form className="form-panel" onSubmit={advance}>
          <div className="mobile-progress">Step {step + 1} of {steps.length}<span><i style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></span></div>
          <span className="kicker">{steps[step]}</span><h1>{heading[step]}</h1>
          <p className="form-lede">{customer ? "Clear details help the right Scout claim your mission quickly." : "Founding Scouts get early access to missions and help us shape the marketplace."}</p>
          <div className="fields">{customer ? <CustomerStep step={step} value={mission} setValue={setMission} quote={quote} preferredScouts={preferredScouts} /> : <ScoutStep step={step} value={scout} setValue={setScout} email={user?.primaryEmailAddress?.emailAddress ?? "Your verified account email"} headshot={scoutHeadshot} onHeadshot={chooseScoutHeadshot} />}</div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="button button-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || isPending}><IconArrowLeft size={19} /> Back</button>
            <button className="button" type="submit" disabled={isPending}>{isPending ? (customer ? "Opening secure payment…" : "Finishing application…") : step === steps.length - 1 ? (customer ? "Continue to secure payment" : "Join the network") : "Continue"}<IconArrowRight size={19} /></button>
          </div>
        </form>
      </section>
    </main>
  );
}

function CustomerStep({ step, value, setValue, quote, preferredScouts }: { step: number; value: MissionInput; setValue: React.Dispatch<React.SetStateAction<MissionInput>>; quote: MissionCreationQuote | null; preferredScouts: PreferredScoutOption[] }) {
  const set = <K extends keyof MissionInput>(key: K, next: MissionInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  if (step === 0) return <div className="choice-grid">{[["see", "See It", "Photos, video and answers"], ["move", "Move It", "A prepaid item from A to B"], ["meet", "Meet It", "Wait or meet someone for me"]].map(([id, title, text]) => <label className="choice" key={id}><input required type="radio" name="mission" value={id} checked={value.type === id} onChange={() => setValue((old) => ({ ...old, type: id as MissionInput["type"], addMoveLeg: id === "meet" ? old.addMoveLeg : false, deliveryPinRequired: id === "move" ? old.deliveryPinRequired : false, deliveryPin: id === "move" ? old.deliveryPin : "" }))} /><span><strong>{title}</strong><small>{text}</small></span></label>)}</div>;
  const optionsStep = value.type === "move" ? 4 : 3;
  if (step === optionsStep) return <MissionOptions value={value} set={set} preferredScouts={preferredScouts} />;
  if (value.type === "move") return <MoveMissionStep step={step} value={value} set={set} quote={quote} />;
  if (step === 1) return <>
    <Field label={value.type === "meet" ? "Meeting location" : "Inspection location"} placeholder="Street address" value={value.address} onChange={(event) => set("address", event.target.value)} />
    <Field label="Apartment, suite, etc. (optional)" required={false} value={value.addressLine2} onChange={(event) => set("addressLine2", event.target.value)} />
    <div className="route-location-row">
      <Field label="City" placeholder="Austin" value={value.city} onChange={(event) => set("city", event.target.value)} />
      <Field label="State" maxLength={2} value={value.state} onChange={(event) => {
        const state = event.target.value.toUpperCase();
        setValue((old) => ({ ...old, state, timeZone: defaultMissionTimeZoneForState(state) }));
      }} />
      <Field label="ZIP code" placeholder="78701" inputMode="numeric" value={value.zip} onChange={(event) => set("zip", event.target.value)} />
    </div>
    <Field label={value.type === "meet" ? "When should the Scout arrive?" : "When do you need a Scout?"} type="datetime-local" readOnly={Boolean(value.recurrenceScheduleId)} value={value.scheduledFor} onChange={(event) => set("scheduledFor", event.target.value)} />
    <TimeZoneField value={value.timeZone} onChange={(timeZone) => set("timeZone", timeZone)} />
  </>;
  if (step === 2) return <><Field label={value.type === "meet" ? "Who or what is the appointment with?" : "What should the Scout inspect?"} placeholder={value.type === "meet" ? "Meet the cable technician at the property" : "Photograph used equipment before purchase"} value={value.title} onChange={(event) => set("title", event.target.value)} /><label className="field"><span>{value.type === "meet" ? "Meeting or waiting instructions" : "Questions, photos and details needed"}</span><textarea required rows={5} placeholder={value.type === "meet" ? "Who to meet, the appointment window, access details and what to confirm…" : "Explain what the Scout should inspect, ask or document…"} value={value.instructions} onChange={(event) => set("instructions", event.target.value)} /></label>{value.type === "meet" && <label className="field"><span>Maximum authorized appointment time</span><select value={value.meetAuthorizedMinutes} onChange={(event) => set("meetAuthorizedMinutes", Number(event.target.value))}><option value={60}>1 hour · maximum $29</option><option value={120}>2 hours · maximum $54</option><option value={180}>3 hours · maximum $79</option><option value={240}>4 hours · maximum $104</option></select><small>You pay the $29 first-hour minimum, then only the verified time used in 15-minute increments. Extensions require your approval.</small></label>}<Field label="Best phone number" type="tel" placeholder="555-123-4567" value={value.phone} onChange={(event) => set("phone", event.target.value)} /></>;
  return <div className="review-box"><Review label="Mission" value={value.addMoveLeg ? `${titleCase(value.type)} It + Move It · 2 parts` : `${titleCase(value.type)} It`} /><Review label="Location" value={`${value.city || "City"}, ${value.state || "State"} ${value.zip}`} /><Review label="Timing" value={value.scheduledFor ? formatLocalInput(value.scheduledFor, value.timeZone) : "As soon as possible"} />{value.addMoveLeg && <Review label="Follow-up delivery" value={`${value.bundleDropoffName} · ${formatMovePlace(value.bundleDropoffAddress, value.bundleDropoffCity, value.bundleDropoffState, value.bundleDropoffZip)}`} />}<Review label={value.recurrenceScheduleId ? "Recurring occurrence" : "Repeat schedule"} value={value.recurrenceScheduleId ? "One reviewed occurrence · payment required to publish" : recurrenceLabel(value.recurrence, value.timeZone)} />{value.preferredScoutId && <Review label="Scout preference" value="Offer to your preferred Scout for 1 hour after payment" />}{value.enhancedReport && <Review label={value.addMoveLeg ? "Enhanced report · Meet It part" : "Enhanced report"} value={`${value.checklistItems.length} required item${value.checklistItems.length === 1 ? "" : "s"}`} />}{quote?.itemized.map((line) => <Review key={line.label} label={line.label} value={money(line.customerPriceCents)} />)}<Review label="Due now" value={money(quote?.totalCustomerPriceCents ?? 2900)} />{value.type === "meet" && <Review label="Authorized maximum" value={`${value.meetAuthorizedMinutes / 60} hour${value.meetAuthorizedMinutes === 60 ? "" : "s"} · ${money(quote?.maximumCustomerPriceCents ?? 2900)} for part 1`} />}<p>{value.type === "meet" ? "The first-hour minimum is collected now. Verified time beyond the first hour is charged later in 15-minute increments and cannot exceed your approved maximum." : "Your payment is collected securely before the mission is released to Scouts."}</p>{value.addMoveLeg && <p>One eligible Scout claims both ordered parts. The $4 multi-mission discount comes from Send a Scout’s portion; Scout pay is not reduced.</p>}<p>You’ll continue to Stripe Checkout. The mission stays private until Stripe confirms payment.</p></div>;
}

function MoveMissionStep({ step, value, set, quote }: { step: number; value: MissionInput; set: <K extends keyof MissionInput>(key: K, next: MissionInput[K]) => void; quote: MissionCreationQuote | null }) {
  if (step === 1) return <>
    <div className="route-stop-heading"><span>1</span><div><strong>Pickup</strong><small>Where the Scout will collect the item</small></div></div>
    <Field label="Pickup business or person" placeholder="ABC Hardware" value={value.pickupName} onChange={(event) => set("pickupName", event.target.value)} />
    <Field label="Pickup address" placeholder="123 Main Street" value={value.pickupAddress} onChange={(event) => set("pickupAddress", event.target.value)} />
    <Field label="Suite, unit, etc. (optional)" required={false} value={value.pickupAddressLine2} onChange={(event) => set("pickupAddressLine2", event.target.value)} />
    <div className="route-location-row"><Field label="City" value={value.pickupCity} onChange={(event) => set("pickupCity", event.target.value)} /><Field label="State" maxLength={2} value={value.pickupState} onChange={(event) => { const state = event.target.value.toUpperCase(); set("pickupState", state); set("timeZone", defaultMissionTimeZoneForState(state)); }} /><Field label="ZIP code" inputMode="numeric" value={value.pickupZip} onChange={(event) => set("pickupZip", event.target.value)} /></div>
    <label className="field"><span>Pickup instructions (optional)</span><textarea rows={3} placeholder="Order name or number, pickup counter, who to ask for…" value={value.pickupInstructions} onChange={(event) => set("pickupInstructions", event.target.value)} /></label>
    <Field label="When should the Scout pick it up?" type="datetime-local" readOnly={Boolean(value.recurrenceScheduleId)} value={value.scheduledFor} onChange={(event) => set("scheduledFor", event.target.value)} />
    <TimeZoneField value={value.timeZone} onChange={(timeZone) => set("timeZone", timeZone)} />
  </>;
  if (step === 2) return <>
    <div className="route-stop-heading dropoff"><span>2</span><div><strong>Drop-off</strong><small>Who should receive it and where</small></div></div>
    <Field label="Drop-off business or person" placeholder="Kyle at Send a Scout" value={value.dropoffName} onChange={(event) => set("dropoffName", event.target.value)} />
    <Field label="Drop-off address" placeholder="456 Broad Street" value={value.dropoffAddress} onChange={(event) => set("dropoffAddress", event.target.value)} />
    <Field label="Suite, unit, etc. (optional)" required={false} value={value.dropoffAddressLine2} onChange={(event) => set("dropoffAddressLine2", event.target.value)} />
    <div className="route-location-row"><Field label="City" value={value.dropoffCity} onChange={(event) => set("dropoffCity", event.target.value)} /><Field label="State" maxLength={2} value={value.dropoffState} onChange={(event) => set("dropoffState", event.target.value.toUpperCase())} /><Field label="ZIP code" inputMode="numeric" value={value.dropoffZip} onChange={(event) => set("dropoffZip", event.target.value)} /></div>
    <label className="field"><span>Delivery instructions (optional)</span><textarea rows={4} placeholder="Where to park, who may accept it, call on arrival, leave at service desk…" value={value.deliveryInstructions} onChange={(event) => set("deliveryInstructions", event.target.value)} /></label>
  </>;
  if (step === 3) return <>
    <Field label="What should the Scout pick up?" placeholder="Prepaid alternator from ABC Auto Parts" value={value.title} onChange={(event) => set("title", event.target.value)} />
    <div className="choice-grid"><label className="choice"><input type="radio" name="item-size" checked={!value.largeItem} onChange={() => set("largeItem", false)} /><span><strong>Small item</strong><small>Under 25 lb and fits in a car or trunk</small></span></label><label className="choice"><input type="radio" name="item-size" checked={value.largeItem} onChange={() => set("largeItem", true)} /><span><strong>Larger item</strong><small>Needs an SUV, van or pickup truck · +$10</small></span></label></div>
    <label className="field"><span>Item and handling details</span><textarea required rows={5} placeholder="Describe the item, approximate size, whether it is prepaid, fragile or requires special handling…" value={value.instructions} onChange={(event) => set("instructions", event.target.value)} /></label>
    <Field label="Best phone number" type="tel" placeholder="555-123-4567" value={value.phone} onChange={(event) => set("phone", event.target.value)} />
  </>;
  return <div className="review-box move-review"><Review label="Mission" value="Move It" /><Review label="Item" value={value.title || "Item description"} /><Review label="Item class" value={value.largeItem ? "Larger item · SUV, van or pickup" : "Small item · car or trunk"} /><Review label="Pickup" value={`${value.pickupName || "Pickup"} · ${formatMovePlace(value.pickupAddress, value.pickupCity, value.pickupState, value.pickupZip)}`} /><Review label="Drop-off" value={`${value.dropoffName || "Drop-off"} · ${formatMovePlace(value.dropoffAddress, value.dropoffCity, value.dropoffState, value.dropoffZip)}`} /><Review label="Pickup time" value={value.scheduledFor ? formatLocalInput(value.scheduledFor, value.timeZone) : "As soon as possible"} /><Review label="Delivery confirmation" value={value.deliveryMethod === "hand_to_recipient" ? value.deliveryPinRequired ? "Hand-off · recipient PIN required" : "Hand-off to recipient" : "Leave at approved location"} /><Review label="Proof of delivery" value="Photo required" /><Review label="Repeat schedule" value={recurrenceLabel(value.recurrence, value.timeZone)} />{quote?.itemized.map((line) => <Review key={line.label} label={line.label} value={money(line.customerPriceCents)} />)}<Review label="Mission total" value={money(quote?.totalCustomerPriceCents ?? 1900)} />{quote?.estimatedRouteMiles !== null && quote?.estimatedRouteMiles !== undefined && <Review label={quote.routeSource === "google" ? "Verified driving route" : "Estimated route"} value={`${quote.estimatedRouteMiles} mile${quote.estimatedRouteMiles === 1 ? "" : "s"}`} />}<p>Includes the first 3 route miles. Additional miles are $1.75 each. The verified road mileage and price are locked before a Scout accepts.</p><p>A private delivery photo is required and will be visible to you. If you selected a PIN, the Scout must enter the code supplied by the recipient—the Scout is never shown your PIN.</p><p>You won’t be charged yet.</p></div>;
}

function MissionOptions({ value, set, preferredScouts }: { value: MissionInput; set: <K extends keyof MissionInput>(key: K, next: MissionInput[K]) => void; preferredScouts: PreferredScoutOption[] }) {
  const updateChecklist = (index: number, patch: Partial<MissionInput["checklistItems"][number]>) => set("checklistItems", value.checklistItems.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  return <div className="mission-options">
    {value.type === "move" && <DeliveryConfirmation method={value.deliveryMethod} pinRequired={value.deliveryPinRequired} pin={value.deliveryPin} onMethod={(method) => { set("deliveryMethod", method); if (method === "leave_at_location") { set("deliveryPinRequired", false); set("deliveryPin", ""); } }} onPinRequired={(required) => set("deliveryPinRequired", required)} onPin={(pin) => set("deliveryPin", pin)} />}
    {value.recurrenceScheduleId
      ? <section className="option-card"><h3>Recurring occurrence</h3><p>This due date was loaded from your customer-controlled schedule. Publishing creates only this reviewed mission; the schedule never charges you or publishes future work automatically.</p></section>
      : <section className="option-card"><h3>Repeat schedule</h3><p>Save time on work you expect to request again. Recurrences create a customer-controlled schedule, never an unpaid automatic mission.</p><label className="field"><span>How often?</span><select value={value.recurrence} onChange={(event) => set("recurrence", event.target.value as MissionInput["recurrence"])}><option value="once">One time</option><option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Every month</option></select></label>{value.recurrence !== "once" && <Field label="End date (optional)" required={false} type="date" value={value.recurrenceEndsOn} onChange={(event) => set("recurrenceEndsOn", event.target.value)} />}</section>}
    <section className="option-card"><label className="check option-toggle"><input type="checkbox" checked={value.enhancedReport} onChange={(event) => { set("enhancedReport", event.target.checked); if (event.target.checked && !value.checklistItems.length) set("checklistItems", [{ prompt: "", responseType: "text" }]); }} /><span><strong>Enhanced mission report · +$9</strong><small>{value.addMoveLeg ? "For this two-part mission, the checklist applies to the first Meet It leg only. $6 is added to Scout pay." : "Build required questions, confirmations or photo requests. $6 is added to Scout pay."}</small></span></label>{value.enhancedReport && <div className="checklist-builder">{value.addMoveLeg && <p className="checklist-scope">These required items will appear during the Meet It appointment, not the Move It delivery.</p>}{value.checklistItems.map((item, index) => <div className="checklist-row" key={index}><span>{index + 1}</span><input aria-label={`Checklist item ${index + 1}`} maxLength={180} placeholder="What must the Scout document?" required value={item.prompt} onChange={(event) => updateChecklist(index, { prompt: event.target.value })} /><select aria-label={`Response type for item ${index + 1}`} value={item.responseType} onChange={(event) => updateChecklist(index, { responseType: event.target.value as typeof item.responseType })}><option value="text">Written answer</option><option value="check">Confirm complete</option><option value="photo">Photo</option></select><button aria-label={`Remove checklist item ${index + 1}`} type="button" onClick={() => set("checklistItems", value.checklistItems.filter((_, itemIndex) => itemIndex !== index))}><IconTrash size={17} /></button></div>)}<button className="button button-ghost button-small" type="button" disabled={value.checklistItems.length >= 10} onClick={() => set("checklistItems", [...value.checklistItems, { prompt: "", responseType: "text" }])}><IconPlus size={16} /> Add report item</button></div>}</section>
    {value.type === "meet" && <section className="option-card"><label className="check option-toggle"><input type="checkbox" checked={value.addMoveLeg} onChange={(event) => set("addMoveLeg", event.target.checked)} /><span><strong>Add a Move It follow-up</strong><small>The same Scout completes a delivery after the meeting. Save $4 versus booking separately.</small></span></label>{value.addMoveLeg && <div className="bundle-fields"><Field label="What will the Scout take?" placeholder="Signed documents or a small package" value={value.bundleTitle} onChange={(event) => set("bundleTitle", event.target.value)} /><label className="field"><span>Item and handling details</span><textarea required rows={3} value={value.bundleInstructions} onChange={(event) => set("bundleInstructions", event.target.value)} /></label><Field label="Recipient or business" value={value.bundleDropoffName} onChange={(event) => set("bundleDropoffName", event.target.value)} /><Field label="Drop-off address" value={value.bundleDropoffAddress} onChange={(event) => set("bundleDropoffAddress", event.target.value)} /><Field label="Suite, unit, etc. (optional)" required={false} value={value.bundleDropoffAddressLine2} onChange={(event) => set("bundleDropoffAddressLine2", event.target.value)} /><div className="route-location-row"><Field label="City" value={value.bundleDropoffCity} onChange={(event) => set("bundleDropoffCity", event.target.value)} /><Field label="State" maxLength={2} value={value.bundleDropoffState} onChange={(event) => set("bundleDropoffState", event.target.value.toUpperCase())} /><Field label="ZIP code" inputMode="numeric" value={value.bundleDropoffZip} onChange={(event) => set("bundleDropoffZip", event.target.value)} /></div><label className="field"><span>Delivery instructions (optional)</span><textarea rows={3} value={value.bundleDeliveryInstructions} onChange={(event) => set("bundleDeliveryInstructions", event.target.value)} /></label><div className="check-grid"><label className="choice"><input type="radio" name="bundle-item-size" checked={!value.bundleLargeItem} onChange={() => set("bundleLargeItem", false)} /><span><strong>Small item</strong><small>Fits in a car or trunk</small></span></label><label className="choice"><input type="radio" name="bundle-item-size" checked={value.bundleLargeItem} onChange={() => set("bundleLargeItem", true)} /><span><strong>Larger item</strong><small>SUV, van or pickup needed</small></span></label></div><DeliveryConfirmation method={value.bundleDeliveryMethod} pinRequired={value.bundleDeliveryPinRequired} pin={value.bundleDeliveryPin} onMethod={(method) => { set("bundleDeliveryMethod", method); if (method === "leave_at_location") { set("bundleDeliveryPinRequired", false); set("bundleDeliveryPin", ""); } }} onPinRequired={(required) => set("bundleDeliveryPinRequired", required)} onPin={(pin) => set("bundleDeliveryPin", pin)} /></div>}</section>}
    <section className="option-card"><h3>Scout preference</h3><p>A preferred Scout gets a one-hour first look. If they cannot take it, the mission opens to all eligible Scouts automatically.</p><label className="field"><span>Who should see it first?</span><select value={value.preferredScoutId} onChange={(event) => set("preferredScoutId", event.target.value)}><option value="">Any eligible Scout</option>{preferredScouts.map((scout) => <option value={scout.id} key={scout.id}>{scout.firstName} · {scout.completedMissions} completed mission{scout.completedMissions === 1 ? "" : "s"}</option>)}</select></label></section>
    {!value.recurrenceScheduleId && <section className="option-card"><label className="check option-toggle"><input type="checkbox" checked={value.saveAsTemplate} onChange={(event) => set("saveAsTemplate", event.target.checked)} /><span><strong>Save as a reusable template</strong><small>Locations and instructions are saved. PINs, payments, evidence and Scout assignment are never copied.</small></span></label>{value.saveAsTemplate && <Field label="Template name" required={false} placeholder={`${value.title || missionLabel(value.type)} template`} value={value.templateName} onChange={(event) => set("templateName", event.target.value)} />}</section>}
  </div>;
}

function DeliveryConfirmation({ method, pinRequired, pin, onMethod, onPinRequired, onPin }: { method: MissionInput["deliveryMethod"]; pinRequired: boolean; pin: string; onMethod: (method: MissionInput["deliveryMethod"]) => void; onPinRequired: (required: boolean) => void; onPin: (pin: string) => void }) {
  return <fieldset className="option-card delivery-confirmation"><legend>Delivery confirmation</legend><p>A private proof-of-delivery photo is always required for new Move It missions.</p><div className="choice-grid"><label className="choice"><input type="radio" name={`delivery-method-${pinRequired ? "pin" : "plain"}`} checked={method === "hand_to_recipient"} onChange={() => onMethod("hand_to_recipient")} /><span><strong>Hand to recipient</strong><small>Someone will receive the item</small></span></label><label className="choice"><input type="radio" name={`delivery-method-${pinRequired ? "pin" : "plain"}`} checked={method === "leave_at_location"} onChange={() => onMethod("leave_at_location")} /><span><strong>Leave at approved location</strong><small>The delivery photo confirms placement</small></span></label></div>{method === "hand_to_recipient" && <><label className="check option-toggle"><input type="checkbox" checked={pinRequired} onChange={(event) => onPinRequired(event.target.checked)} /><span><strong>Require a recipient PIN</strong><small>Create, save and share the code privately with the recipient now. The Scout is never shown it.</small></span></label>{pinRequired && <><Field label="6-digit recipient PIN" type="text" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={pin} onChange={(event) => onPin(event.target.value.replace(/\D/g, "").slice(0, 6))} /><p className="pin-warning" role="note"><strong>Save and share this PIN before publishing.</strong> For security, it cannot be viewed or recovered later by you, the Scout or support.</p></>}</>}</fieldset>;
}

function ScoutStep({ step, value, setValue, email, headshot, onHeadshot }: { step: number; value: ScoutInput; setValue: React.Dispatch<React.SetStateAction<ScoutInput>>; email: string; headshot: File | null; onHeadshot: (file: File | null) => void }) {
  const set = <K extends keyof ScoutInput>(key: K, next: ScoutInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  if (step === 0) return <><div className="field-row"><Field label="First name" placeholder="Jordan" value={value.firstName} onChange={(event) => set("firstName", event.target.value)} /><Field label="Last name" placeholder="Taylor" value={value.lastName} onChange={(event) => set("lastName", event.target.value)} /></div><Field label="Account email" type="email" value={email} readOnly required={false} /><Field label="Mobile number" type="tel" placeholder="555-123-4567" value={value.phone} onChange={(event) => set("phone", event.target.value)} /></>;
  if (step === 1) return <><Field label="Home ZIP code" placeholder="78701" inputMode="numeric" value={value.homeZip} onChange={(event) => set("homeZip", event.target.value)} /><label className="field"><span>How far are you willing to travel?</span><select required value={value.radius} onChange={(event) => set("radius", Number(event.target.value))}><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option><option value={75}>75+ miles</option></select></label><div className="check-grid"><Check label="See It missions" checked={value.canSee} onChange={(checked) => set("canSee", checked)} /><Check label="Move It missions" checked={value.canMove} onChange={(checked) => set("canMove", checked)} /><Check label="Meet It missions" checked={value.canMeet} onChange={(checked) => set("canMeet", checked)} /></div></>;
  if (step === 2) return <><label className="field"><span>Vehicle access</span><select required value={value.vehicleType} onChange={(event) => set("vehicleType", event.target.value)}><option value="" disabled>Select your vehicle</option><option>Car</option><option>SUV</option><option>Pickup truck</option><option>Van</option><option>No vehicle</option></select></label><Field label="Gig-work experience (optional)" required={false} placeholder="DoorDash, Uber, field inspections, courier work…" value={value.experience} onChange={(event) => set("experience", event.target.value)} /><div className="headshot-editor onboarding-headshot"><div className="headshot-preview"><IconCamera size={34} /></div><div><h3>Profile headshot <span aria-hidden="true">*</span></h3><p>A clear, current JPG, PNG, or WEBP photo of your face is required before Control Room can approve your application. Maximum 5 MB.</p><label className="button button-ghost button-small">{headshot ? "Change photo" : "Choose photo"}<input type="file" accept="image/jpeg,image/png,image/webp" required={!headshot} onChange={(event) => onHeadshot(event.target.files?.[0] ?? null)} /></label>{headshot && <small className="selected-file"><IconCheck size={15} /> {headshot.name}</small>}</div></div><label className="check notification-check"><input type="checkbox" checked={value.smsNotificationsEnabled} onChange={(event) => set("smsNotificationsEnabled", event.target.checked)} /><span><strong>Text mission alerts (optional)</strong><small>By checking this box, I agree to receive transactional mission and account texts from Send a Scout. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of participation. See <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy</Link>.</small></span></label><label className="check consent"><input required type="checkbox" checked={value.consent} onChange={(event) => set("consent", event.target.checked)} /> I am at least 18 and agree to identity and background verification before accepting missions.</label></>;
  if (step === 3) return <div className="handbook-reader-card"><div className="handbook-reader-scroll" tabIndex={0} aria-label="Scrollable Scout Handbook"><ScoutHandbookContent variant="reader" /></div><div className="handbook-acceptance-form"><label className="handbook-acceptance-check"><input required type="checkbox" checked={value.handbookAccepted} onChange={(event) => set("handbookAccepted", event.target.checked)} /><span>{SCOUT_HANDBOOK_ACKNOWLEDGEMENT}</span></label><small>The current handbook will remain available from your Scout dashboard.</small></div></div>;
  const access = [value.canSee && "See It", value.canMove && "Move It", value.canMeet && "Meet It"].filter(Boolean).join(" · ");
  return <div className="review-box"><Review label="Delivery zone" value={`${value.homeZip} · within ${value.radius} miles`} /><Review label="Mission access" value={access || "None selected"} /><Review label="Profile photo" value={headshot?.name ?? "Required before submission"} /><Review label="Scout Handbook" value={value.handbookAccepted ? `Reviewed and acknowledged · ${SCOUT_HANDBOOK_VERSION}` : "Acknowledgment required"} /><Review label="Registration cost" value="$0" /><Review label="Payout options" value="Same-day options planned" /><p>You’ll see matching missions anywhere inside your selected delivery zone. Submitting does not create an employment relationship or guarantee missions.</p></div>;
}

function Field({ label, required = true, ...props }: { label: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) { return <label className="field"><span>{label}</span><input required={required} {...props} /></label>; }
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>; }
function Review({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
function missionLabel(type: MissionInput["type"]) { return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It"; }
function recurrenceLabel(value: MissionInput["recurrence"], timeZone: string) { return value === "weekly" ? `Every week · ${missionTimeZoneLabel(timeZone)}` : value === "biweekly" ? `Every 2 weeks · ${missionTimeZoneLabel(timeZone)}` : value === "monthly" ? `Every month · ${missionTimeZoneLabel(timeZone)}` : "One time"; }
function formatMovePlace(address: string, city: string, state: string, zip: string) { return [address, city, state, zip].filter(Boolean).join(", "); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function formatLocalInput(value: string, timeZone: string) {
  return formatDateTime(localDateTimeToUtc(value, timeZone), timeZone);
}

function TimeZoneField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="field"><span>Mission time zone</span><select required value={value} onChange={(event) => onChange(event.target.value)}>{US_TIME_ZONE_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><small>Scheduled times follow the mission location, even when you are booking from somewhere else.</small></label>;
}
