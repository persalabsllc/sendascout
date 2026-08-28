"use client";

import { useState, useTransition } from "react";
import { IconCheck } from "@tabler/icons-react";
import { saveScoutSettings, type ScoutSettingsInput } from "@/app/actions/profile";

export function ScoutSettingsForm({ initial }: { initial: ScoutSettingsInput }) {
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof ScoutSettingsInput>(key: K, next: ScoutSettingsInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  function save() {
    setMessage("");
    startTransition(async () => {
      const result = await saveScoutSettings(value);
      setMessage(result.ok ? "Your Scout settings are saved." : result.error);
    });
  }
  return <div className="settings-form">
    <div className="field-row"><label className="field"><span>Home ZIP code</span><input inputMode="numeric" value={value.homeZip} onChange={(event) => set("homeZip", event.target.value)} /></label><label className="field"><span>Travel radius</span><select value={value.serviceRadiusMiles} onChange={(event) => set("serviceRadiusMiles", Number(event.target.value))}><option value={10}>10 miles</option><option value={25}>25 miles</option><option value={50}>50 miles</option><option value={75}>75+ miles</option></select></label></div>
    <label className="field"><span>Vehicle</span><select value={value.vehicleType} onChange={(event) => set("vehicleType", event.target.value)}><option value="">Select your vehicle</option><option>Car</option><option>SUV</option><option>Pickup truck</option><option>Van</option><option>No vehicle</option></select></label>
    <div className="check-grid"><Check label="See It missions" checked={value.canSee} onChange={(next) => set("canSee", next)} /><Check label="Move It missions" checked={value.canMove} onChange={(next) => set("canMove", next)} /><Check label="Meet It missions" checked={value.canMeet} onChange={(next) => set("canMeet", next)} /></div>
    {message && <p className={message.includes("saved") ? "form-success" : "form-error"}>{message}</p>}
    <button className="button" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save settings"}{!pending && <IconCheck size={18} />}</button>
  </div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>; }
