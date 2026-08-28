"use client";

import { FormEvent, useState, useTransition } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { IconArrowLeft, IconArrowRight, IconCheck, IconCircleCheck, IconLock } from "@tabler/icons-react";
import { createMission, createScoutApplication, type MissionInput, type ScoutInput } from "@/app/actions/onboarding";
import { Brand } from "./brand";

type Mode = "customer" | "scout";
const customerSteps = ["Mission", "Location", "Details", "Review"];
const scoutSteps = ["You", "Area", "Setup", "Review"];

const emptyMission: MissionInput = { type: "see", address: "", city: "", zip: "", scheduledFor: "", title: "", instructions: "", phone: "" };
const emptyScout: ScoutInput = { firstName: "", lastName: "", phone: "", homeZip: "", radius: 25, vehicleType: "", experience: "", canSee: true, canMove: true, canMeet: true, consent: false };

export function OnboardingForm({ mode, initialMissionType = "see" }: { mode: Mode; initialMissionType?: MissionInput["type"] }) {
  const { user } = useUser();
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const [mission, setMission] = useState<MissionInput>({ ...emptyMission, type: initialMissionType });
  const [scout, setScout] = useState<ScoutInput>({ ...emptyScout, firstName: user?.firstName ?? "", lastName: user?.lastName ?? "" });
  const steps = mode === "customer" ? customerSteps : scoutSteps;
  const customer = mode === "customer";
  const heading = customer
    ? ["What kind of mission?", "Where is the mission?", "Tell your Scout what success looks like", "Review your mission"]
    : ["Let’s get to know you", "Where do you want to Scout?", "Set up your Scout profile", "Review your application"];

  function advance(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (step < steps.length - 1) return setStep((value) => value + 1);
    startTransition(async () => {
      const result = customer ? await createMission(mission) : await createScoutApplication(scout);
      if (result.ok) setComplete(true);
      else setError(result.error);
    });
  }

  if (complete) return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure onboarding</span></header>
      <section className="success-card">
        <span className="success-icon"><IconCircleCheck size={48} /></span>
        <span className="kicker">{customer ? "Mission saved" : "Application received"}</span>
        <h1>{customer ? "Your mission is in your dashboard." : "Welcome to the Scout network."}</h1>
        <p>{customer ? "The mission is saved as a draft. Payments and live Scout matching will activate during the Eastern North Carolina soft launch." : "Your founding Scout profile is saved. We’ll contact you before the Eastern North Carolina soft launch."}</p>
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
          <div className="fields">{customer ? <CustomerStep step={step} value={mission} setValue={setMission} /> : <ScoutStep step={step} value={scout} setValue={setScout} email={user?.primaryEmailAddress?.emailAddress ?? "Your verified account email"} />}</div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="button button-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || isPending}><IconArrowLeft size={19} /> Back</button>
            <button className="button" type="submit" disabled={isPending}>{isPending ? "Saving…" : step === steps.length - 1 ? (customer ? "Save mission" : "Join the network") : "Continue"}<IconArrowRight size={19} /></button>
          </div>
        </form>
      </section>
    </main>
  );
}

function CustomerStep({ step, value, setValue }: { step: number; value: MissionInput; setValue: React.Dispatch<React.SetStateAction<MissionInput>> }) {
  const set = <K extends keyof MissionInput>(key: K, next: MissionInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  if (step === 0) return <div className="choice-grid">{[["see", "See It", "Photos, video and answers"], ["move", "Move It", "A prepaid item from A to B"], ["meet", "Meet It", "Wait or meet someone for me"]].map(([id, title, text]) => <label className="choice" key={id}><input required type="radio" name="mission" value={id} checked={value.type === id} onChange={() => set("type", id as MissionInput["type"])} /><span><strong>{title}</strong><small>{text}</small></span></label>)}</div>;
  if (step === 1) return <><Field label="Mission address" placeholder="Street address" value={value.address} onChange={(event) => set("address", event.target.value)} /><div className="field-row"><Field label="City" placeholder="New Bern" value={value.city} onChange={(event) => set("city", event.target.value)} /><Field label="ZIP code" placeholder="28560" inputMode="numeric" value={value.zip} onChange={(event) => set("zip", event.target.value)} /></div><Field label="When do you need a Scout?" type="datetime-local" value={value.scheduledFor} onChange={(event) => set("scheduledFor", event.target.value)} /></>;
  if (step === 2) return <><Field label="Mission title" placeholder="Photograph used equipment before purchase" value={value.title} onChange={(event) => set("title", event.target.value)} /><label className="field"><span>Instructions for your Scout</span><textarea required rows={5} placeholder="Explain what the Scout should do, ask or document…" value={value.instructions} onChange={(event) => set("instructions", event.target.value)} /></label><Field label="Best phone number" type="tel" placeholder="(252) 555-0123" value={value.phone} onChange={(event) => set("phone", event.target.value)} /></>;
  return <div className="review-box"><Review label="Mission" value={`${titleCase(value.type)} It`} /><Review label="Location" value={`${value.city || "City"}, NC ${value.zip}`} /><Review label="Timing" value={value.scheduledFor ? new Date(value.scheduledFor).toLocaleString() : "As soon as possible"} /><Review label="Estimated service" value={value.type === "see" ? "$39" : "$49"} /><p>You won’t be charged yet. Payments and matching will be activated before the soft launch.</p></div>;
}

function ScoutStep({ step, value, setValue, email }: { step: number; value: ScoutInput; setValue: React.Dispatch<React.SetStateAction<ScoutInput>>; email: string }) {
  const set = <K extends keyof ScoutInput>(key: K, next: ScoutInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  if (step === 0) return <><div className="field-row"><Field label="First name" placeholder="Jordan" value={value.firstName} onChange={(event) => set("firstName", event.target.value)} /><Field label="Last name" placeholder="Taylor" value={value.lastName} onChange={(event) => set("lastName", event.target.value)} /></div><Field label="Account email" type="email" value={email} readOnly required={false} /><Field label="Mobile number" type="tel" placeholder="(252) 555-0123" value={value.phone} onChange={(event) => set("phone", event.target.value)} /></>;
  if (step === 1) return <><Field label="Home ZIP code" placeholder="28560" inputMode="numeric" value={value.homeZip} onChange={(event) => set("homeZip", event.target.value)} /><label className="field"><span>How far are you willing to travel?</span><select required value={value.radius} onChange={(event) => set("radius", Number(event.target.value))}><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option><option value={75}>75+ miles</option></select></label><div className="check-grid"><Check label="See It missions" checked={value.canSee} onChange={(checked) => set("canSee", checked)} /><Check label="Move It missions" checked={value.canMove} onChange={(checked) => set("canMove", checked)} /><Check label="Meet It missions" checked={value.canMeet} onChange={(checked) => set("canMeet", checked)} /></div></>;
  if (step === 2) return <><label className="field"><span>Vehicle access</span><select required value={value.vehicleType} onChange={(event) => set("vehicleType", event.target.value)}><option value="" disabled>Select your vehicle</option><option>Car</option><option>SUV</option><option>Pickup truck</option><option>Van</option><option>No vehicle</option></select></label><Field label="Gig-work experience (optional)" required={false} placeholder="DoorDash, Uber, field inspections, courier work…" value={value.experience} onChange={(event) => set("experience", event.target.value)} /><label className="check consent"><input required type="checkbox" checked={value.consent} onChange={(event) => set("consent", event.target.checked)} /> I am at least 18 and agree to identity and background verification before accepting missions.</label></>;
  const access = [value.canSee && "See It", value.canMove && "Move It", value.canMeet && "Meet It"].filter(Boolean).join(" · ");
  return <div className="review-box"><Review label="Launch area" value={`${value.homeZip} · ${value.radius}+ miles`} /><Review label="Mission access" value={access || "None selected"} /><Review label="Registration cost" value="$0" /><Review label="Payout options" value="Same-day options planned" /><p>Submitting joins the pre-launch network. It does not create an employment relationship or guarantee missions.</p></div>;
}

function Field({ label, required = true, ...props }: { label: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) { return <label className="field"><span>{label}</span><input required={required} {...props} /></label>; }
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>; }
function Review({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function titleCase(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
