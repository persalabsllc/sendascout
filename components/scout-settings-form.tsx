"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import { IconCamera, IconCheck } from "@tabler/icons-react";
import { saveScoutHeadshot, saveScoutSettings, type ScoutSettingsInput } from "@/app/actions/profile";

export function ScoutSettingsForm({ initial, headshotUrl, scoutId }: { initial: ScoutSettingsInput; headshotUrl: string | null; scoutId: string }) {
  const [value, setValue] = useState(initial);
  const [message, setMessage] = useState("");
  const [photoUrl, setPhotoUrl] = useState(headshotUrl);
  const [photoPending, setPhotoPending] = useState(false);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof ScoutSettingsInput>(key: K, next: ScoutSettingsInput[K]) => setValue((old) => ({ ...old, [key]: next }));
  function save() {
    setMessage("");
    startTransition(async () => {
      const result = await saveScoutSettings(value);
      setMessage(result.ok ? "Your Scout settings are saved." : result.error);
    });
  }
  async function uploadHeadshot(file: File) {
    setMessage("");
    setPhotoPending(true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Choose a photo smaller than 5 MB.");
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const blob = await upload(`scout-headshots/${scoutId}/${crypto.randomUUID()}-${safeName}`, file, { access: "private", handleUploadUrl: "/api/scout-headshot/upload" });
      const saved = await saveScoutHeadshot(blob.pathname);
      if (!saved.ok) throw new Error(saved.error);
      setPhotoUrl(`/api/scout-headshot?scoutId=self&v=${Date.now()}`);
      setMessage("Your profile photo is saved. A changed verified photo will be reviewed before the verified badge returns.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Your profile photo could not be uploaded.");
    } finally {
      setPhotoPending(false);
    }
  }
  return <div className="settings-form">
    <div className="headshot-editor"><div className="headshot-preview">{photoUrl ? <Image src={photoUrl} alt="Your Scout profile photo" width={112} height={112} unoptimized /> : <IconCamera size={34} />}</div><div><h3>Headshot photo</h3><p>Use a clear, current JPG, PNG, or WEBP photo of your face so customers know whom to expect. Changing a verified photo pauses the badge for re-review.</p><label className="button button-ghost button-small">{photoPending ? "Uploading…" : photoUrl ? "Change photo" : "Add photo"}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadHeadshot(file); }} /></label></div></div>
    <div className="field-row"><label className="field"><span>Home ZIP code</span><input inputMode="numeric" value={value.homeZip} onChange={(event) => set("homeZip", event.target.value)} /></label><label className="field"><span>Delivery zone</span><select value={value.serviceRadiusMiles} onChange={(event) => set("serviceRadiusMiles", Number(event.target.value))}><option value={10}>Within 10 miles</option><option value={25}>Within 25 miles</option><option value={50}>Within 50 miles</option><option value={75}>Within 75 miles</option></select></label></div>
    <label className="field"><span>Vehicle</span><select value={value.vehicleType} onChange={(event) => set("vehicleType", event.target.value)}><option value="">Select your vehicle</option><option>Car</option><option>SUV</option><option>Pickup truck</option><option>Van</option><option>No vehicle</option></select></label>
    <div className="check-grid"><Check label="See It missions" checked={value.canSee} onChange={(next) => set("canSee", next)} /><Check label="Move It missions" checked={value.canMove} onChange={(next) => set("canMove", next)} /><Check label="Meet It missions" checked={value.canMeet} onChange={(next) => set("canMeet", next)} /></div>
    <label className="check notification-check"><input type="checkbox" checked={value.emailNotificationsEnabled} onChange={(event) => set("emailNotificationsEnabled", event.target.checked)} /><span><strong>Email mission alerts</strong><small>Receive new opportunities and important mission updates at your account email.</small></span></label>
    <label className="check notification-check"><input type="checkbox" checked={value.smsNotificationsEnabled} onChange={(event) => set("smsNotificationsEnabled", event.target.checked)} /><span><strong>Text mission alerts (optional)</strong><small>By checking this box, I agree to receive transactional mission and account texts from Send a Scout. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of participation. See <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy</Link>.</small></span></label>
    {message && <p className={message.includes("saved") ? "form-success" : "form-error"}>{message}</p>}
    <button className="button" disabled={pending} onClick={save}>{pending ? "Saving…" : "Save settings"}{!pending && <IconCheck size={18} />}</button>
  </div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> {label}</label>; }
