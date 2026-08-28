"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { IconArrowLeft, IconArrowRight, IconCheck, IconCircleCheck, IconLock } from "@tabler/icons-react";
import { Brand } from "./brand";

type Mode = "customer" | "scout";

const customerSteps = ["Mission", "Location", "Details", "Review"];
const scoutSteps = ["You", "Area", "Setup", "Review"];

export function OnboardingForm({ mode }: { mode: Mode }) {
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const steps = mode === "customer" ? customerSteps : scoutSteps;
  const customer = mode === "customer";

  const heading = useMemo(() => {
    if (customer) return ["What kind of mission?", "Where is the mission?", "Tell your Scout what success looks like", "Review your mission"];
    return ["Let’s get to know you", "Where do you want to Scout?", "Set up your Scout profile", "Review your application"];
  }, [customer]);

  function advance(event: FormEvent) {
    event.preventDefault();
    if (step === steps.length - 1) setComplete(true);
    else setStep((value) => value + 1);
  }

  if (complete) {
    return (
      <main className="onboarding-page">
        <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure onboarding</span></header>
        <section className="success-card">
          <span className="success-icon"><IconCircleCheck size={48} /></span>
          <span className="kicker">{customer ? "Mission drafted" : "Application received"}</span>
          <h1>{customer ? "Your mission is ready for launch." : "Welcome to the Scout network."}</h1>
          <p>{customer ? "We’ve saved the details. Payments and live Scout matching will activate when Send a Scout launches in your area." : "Your founding Scout profile is saved. We’ll contact you before the Eastern North Carolina soft launch."}</p>
          <Link className="button" href="/">Return home <IconArrowRight size={19} /></Link>
        </section>
      </main>
    );
  }

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure onboarding</span></header>
      <section className="onboarding-shell">
        <aside className="progress-panel">
          <Link href="/" className="back-home"><IconArrowLeft size={18} /> Back home</Link>
          <span className="kicker light">{customer ? "Send a Scout" : "Become a Scout"}</span>
          <h2>{customer ? "Let’s build your mission." : "Do work worth leaving the house for."}</h2>
          <ol>
            {steps.map((label, index) => (
              <li className={index === step ? "current" : index < step ? "done" : ""} key={label}>
                <span>{index < step ? <IconCheck size={16} /> : index + 1}</span><div><small>Step {index + 1}</small><strong>{label}</strong></div>
              </li>
            ))}
          </ol>
        </aside>

        <form className="form-panel" onSubmit={advance}>
          <div className="mobile-progress">Step {step + 1} of {steps.length}<span><i style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></span></div>
          <span className="kicker">{steps[step]}</span>
          <h1>{heading[step]}</h1>
          <p className="form-lede">{customer ? "Clear details help the right Scout claim your mission quickly." : "Founding Scouts get early access to missions and help us shape the marketplace."}</p>
          <div className="fields">{customer ? <CustomerStep step={step} /> : <ScoutStep step={step} />}</div>
          <div className="form-actions">
            <button type="button" className="button button-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}><IconArrowLeft size={19} /> Back</button>
            <button className="button" type="submit">{step === steps.length - 1 ? (customer ? "Save mission" : "Join the network") : "Continue"}<IconArrowRight size={19} /></button>
          </div>
        </form>
      </section>
    </main>
  );
}

function CustomerStep({ step }: { step: number }) {
  if (step === 0) return <div className="choice-grid">{[["See It", "Photos, video and answers"], ["Move It", "A prepaid item from A to B"], ["Meet It", "Wait or meet someone for me"]].map(([a,b]) => <label className="choice" key={a}><input required type="radio" name="mission" /><span><strong>{a}</strong><small>{b}</small></span></label>)}</div>;
  if (step === 1) return <><Field label="Mission address" placeholder="Street address" /><div className="field-row"><Field label="City" placeholder="New Bern" /><Field label="ZIP code" placeholder="28560" /></div><Field label="When do you need a Scout?" type="datetime-local" /></>;
  if (step === 2) return <><Field label="Mission title" placeholder="Photograph used equipment before purchase" /><label className="field"><span>Instructions for your Scout</span><textarea required rows={5} placeholder="Explain what the Scout should do, ask or document…" /></label><Field label="Best phone number" type="tel" placeholder="(252) 555-0123" /></>;
  return <div className="review-box"><Review label="Mission" value="See It" /><Review label="Location" value="Eastern North Carolina" /><Review label="Timing" value="As soon as possible" /><Review label="Estimated service" value="Starting at $39" /><p>You won’t be charged in this prototype. Payments and matching will be added before launch.</p></div>;
}

function ScoutStep({ step }: { step: number }) {
  if (step === 0) return <><div className="field-row"><Field label="First name" placeholder="Jordan" /><Field label="Last name" placeholder="Taylor" /></div><Field label="Email address" type="email" placeholder="jordan@example.com" /><Field label="Mobile number" type="tel" placeholder="(252) 555-0123" /></>;
  if (step === 1) return <><Field label="Home ZIP code" placeholder="28560" /><label className="field"><span>How far are you willing to travel?</span><select required defaultValue=""><option value="" disabled>Select a radius</option><option>10 miles</option><option>25 miles</option><option>50 miles</option><option>75+ miles</option></select></label><div className="check-grid">{["See It missions", "Move It missions", "Meet It missions"].map(x => <label className="check" key={x}><input type="checkbox" /> {x}</label>)}</div></>;
  if (step === 2) return <><label className="field"><span>Vehicle access</span><select required defaultValue=""><option value="" disabled>Select your vehicle</option><option>Car</option><option>SUV</option><option>Pickup truck</option><option>Van</option><option>No vehicle</option></select></label><Field label="Gig-work experience (optional)" placeholder="DoorDash, Uber, field inspections, courier work…" /><label className="check consent"><input required type="checkbox" /> I am at least 18 and agree to identity and background verification before accepting missions.</label></>;
  return <div className="review-box"><Review label="Launch area" value="Eastern North Carolina" /><Review label="Mission access" value="See It · Move It · Meet It" /><Review label="Registration cost" value="$0" /><Review label="Payout options" value="Same-day options planned" /><p>Submitting joins the pre-launch network. It does not create an employment relationship or guarantee missions.</p></div>;
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) { return <label className="field"><span>{label}</span><input required {...props} /></label>; }
function Review({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
