"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconCheck, IconShieldCheck, IconX } from "@tabler/icons-react";
import { adminRecordScoutIdentity, adminSetScoutStatus } from "@/app/actions/missions";
import { Brand } from "./brand";

export type ApprovalCheck = { key: string; label: string; complete: boolean };
export type ScoutAdminRow = { id: string; name: string; email: string; phone: string; zip: string; vehicle: string; radius: number; status: string; capabilities: string; identityStatus: string; identityProvider: string | null; identityVerifiedAt: string | null; legalVersion: string | null; legalAcceptedAt: string | null; checklist: ApprovalCheck[] };

export function ControlRoomScouts({ scouts }: { scouts: ScoutAdminRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }
  return <main className="control-page">
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room">Control Room</Link><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <Link className="control-back" href="/control-room"><IconArrowLeft size={16} /> Marketplace operations</Link>
      <div className="control-title"><div><span className="kicker">Scout management</span><h1>Scouts and applications</h1><p>Review applications, identity requirements and Scout account status without crowding the main operations dashboard.</p></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="control-section">
        <div className="control-section-title"><div><h2>All Scouts</h2><p>{scouts.length} Scout account{scouts.length === 1 ? "" : "s"} · newest applications first</p></div></div>
        {scouts.length ? <div className="control-table">{scouts.map((scout) => <article key={scout.id}>
          <div className="control-primary"><strong>{scout.name}</strong><span>{scout.email} · {scout.phone || "No phone"}</span><small>{scout.vehicle || "Vehicle not provided"} · {scout.zip} + {scout.radius} miles · {scout.capabilities}</small><small>{scout.identityStatus === "clear" ? `Identity verified${scout.identityVerifiedAt ? ` ${new Date(scout.identityVerifiedAt).toLocaleDateString()}` : ""}` : "Identity not yet verified"} · {scout.legalVersion ? `Terms ${scout.legalVersion} accepted` : "Terms acceptance pending"}</small><div className="approval-checklist">{scout.checklist.map((item) => <span className={item.complete ? "complete" : "missing"} key={item.key}>{item.complete ? <IconCheck size={13} /> : <IconX size={13} />}{item.label}</span>)}</div></div>
          <span className="status">{titleCase(scout.status)}</span>
          <div className="control-actions">
            {scout.identityStatus !== "clear" && <button disabled={pending} onClick={() => run(() => adminRecordScoutIdentity(scout.id))}><IconShieldCheck size={16} /> Record ID verified</button>}
            {scout.status !== "approved" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "approved"))}><IconCheck size={16} /> Approve</button>}
            {scout.status === "approved" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "paused"))}>Pause</button>}
            {scout.status !== "rejected" && <button className="danger-link" disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "rejected"))}><IconX size={16} /> Reject</button>}
          </div>
        </article>)}</div> : <div className="control-empty">No Scout applications yet.</div>}
        <p className="control-review-note">Record identity as verified only after comparing an original government-issued photo ID with the Scout live, in person or by video. Never accept an ID through email or mission chat. The platform records the reviewer and date, not a copy of the document.</p>
      </section>
    </div>
  </main>;
}

function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
