"use client";

import { FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconCheck, IconLock, IconMapPin, IconUser } from "@tabler/icons-react";
import { saveCustomerProfile, type CustomerProfileInput } from "@/app/actions/profile";
import { Brand } from "./brand";

export function CustomerProfileForm({ initialValue, nextPath }: { initialValue: CustomerProfileInput; nextPath: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();
  const set = <K extends keyof CustomerProfileInput>(key: K, next: CustomerProfileInput[K]) => setValue((old) => ({ ...old, [key]: next }));

  function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await saveCustomerProfile(value);
      if (!result.ok) return setError(result.error);
      router.push(nextPath);
      router.refresh();
    });
  }

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><span className="secure"><IconLock size={15} /> Secure account setup</span></header>
      <section className="profile-setup-shell">
        <aside className="profile-intro">
          <span className="profile-intro-icon"><IconUser size={27} /></span>
          <span className="kicker light">One-time setup</span>
          <h1>Tell us who we’re helping.</h1>
          <p>Your contact information helps Scouts coordinate safely. Your default address saves time but can be changed for every mission.</p>
          <ul><li><IconCheck size={17} /> Used only for your account and missions</li><li><IconCheck size={17} /> Mission locations can be anywhere we serve</li></ul>
        </aside>
        <form className="form-panel profile-form" onSubmit={submit}>
          <span className="kicker">Customer profile</span>
          <h1>Complete your account</h1>
          <p className="form-lede">You’ll only need to enter this once. You can update it from your dashboard later.</p>
          <div className="field-row">
            <Field label="First name" autoComplete="given-name" value={value.firstName} onChange={(event) => set("firstName", event.target.value)} />
            <Field label="Last name" autoComplete="family-name" value={value.lastName} onChange={(event) => set("lastName", event.target.value)} />
          </div>
          <Field label="Mobile number" type="tel" autoComplete="tel" placeholder="(252) 555-0123" value={value.phone} onChange={(event) => set("phone", event.target.value)} />
          <div className="profile-address-label"><IconMapPin size={17} /><div><strong>Default address</strong><span>We’ll prefill this on new missions.</span></div></div>
          <Field label="Street address" autoComplete="street-address" value={value.addressLine1} onChange={(event) => set("addressLine1", event.target.value)} />
          <Field label="Apartment, suite, etc. (optional)" required={false} value={value.addressLine2} onChange={(event) => set("addressLine2", event.target.value)} />
          <div className="profile-location-row">
            <Field label="City" autoComplete="address-level2" value={value.city} onChange={(event) => set("city", event.target.value)} />
            <Field label="State" autoComplete="address-level1" maxLength={2} value={value.state} onChange={(event) => set("state", event.target.value.toUpperCase())} />
            <Field label="ZIP code" inputMode="numeric" autoComplete="postal-code" value={value.zip} onChange={(event) => set("zip", event.target.value)} />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="profile-submit"><button className="button" type="submit" disabled={isPending}>{isPending ? "Saving…" : "Save and continue"}<IconArrowRight size={19} /></button></div>
        </form>
      </section>
    </main>
  );
}

function Field({ label, required = true, ...props }: { label: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="field"><span>{label}</span><input required={required} {...props} /></label>;
}
