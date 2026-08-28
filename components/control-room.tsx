"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconArrowRight, IconBriefcase, IconCheck, IconRoute, IconShieldCheck, IconUsers, IconX } from "@tabler/icons-react";
import { adminSetMissionStatus, adminSetScoutStatus } from "@/app/actions/missions";
import { Brand } from "./brand";

type ScoutRow = { id: string; name: string; email: string; phone: string; zip: string; vehicle: string; radius: number; status: string; capabilities: string };
type MissionRow = { id: string; title: string; type: string; status: string; customer: string; location: string; price: number; payout: number; createdAt: string };

export function ControlRoom({ stats, scouts, missions }: { stats: { users: number; applicants: number; open: number; active: number }; scouts: ScoutRow[]; missions: MissionRow[] }) {
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
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <div className="control-title"><div><span className="kicker">Send a Scout Control Room</span><h1>Marketplace operations</h1><p>Approve Scouts, release missions and oversee every active job.</p></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="control-stats">
        <ControlStat icon={IconUsers} label="Users" value={stats.users} />
        <ControlStat icon={IconShieldCheck} label="Scout applicants" value={stats.applicants} />
        <ControlStat icon={IconBriefcase} label="Open missions" value={stats.open} />
        <ControlStat icon={IconRoute} label="Active missions" value={stats.active} />
      </div>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Scout applications</h2><p>Approve only after identity, driving and background review.</p></div></div>
        {scouts.length ? <div className="control-table">{scouts.map((scout) => <article key={scout.id}>
          <div className="control-primary"><strong>{scout.name}</strong><span>{scout.email} · {scout.phone || "No phone"}</span><small>{scout.vehicle || "Vehicle not provided"} · {scout.zip} + {scout.radius} miles · {scout.capabilities}</small></div>
          <span className="status">{titleCase(scout.status)}</span>
          <div className="control-actions">
            {scout.status !== "approved" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "approved"))}><IconCheck size={16} /> Approve</button>}
            {scout.status === "approved" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "paused"))}>Pause</button>}
            {scout.status !== "rejected" && <button className="danger-link" disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "rejected"))}><IconX size={16} /> Reject</button>}
          </div>
        </article>)}</div> : <div className="control-empty">No Scout applications yet.</div>}
      </section>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Mission queue</h2><p>Opening a mission immediately alerts eligible approved Scouts.</p></div></div>
        {missions.length ? <div className="control-table mission-admin-list">{missions.map((mission) => <article key={mission.id}>
          <div className="control-primary"><small>{titleCase(mission.type)} It · {mission.customer}</small><strong>{mission.title}</strong><span>{mission.location} · Customer {money(mission.price)} · Scout {money(mission.payout)}</span></div>
          <span className={`status ${mission.status === "draft" ? "muted-status" : ""}`}>{titleCase(mission.status)}</span>
          <div className="control-actions">
            <Link href={`/dashboard/missions/${mission.id}`}>Open <IconArrowRight size={16} /></Link>
            {mission.status === "draft" && <button disabled={pending} onClick={() => run(() => adminSetMissionStatus(mission.id, "open"))}>Release to Scouts</button>}
            {!['completed', 'cancelled'].includes(mission.status) && <button className="danger-link" disabled={pending} onClick={() => run(() => adminSetMissionStatus(mission.id, "cancelled"))}>Cancel</button>}
          </div>
        </article>)}</div> : <div className="control-empty">No missions have been submitted.</div>}
      </section>
    </div>
  </main>;
}

function ControlStat({ icon: Icon, label, value }: { icon: typeof IconUsers; label: string; value: number }) { return <article><Icon size={23} /><div><small>{label}</small><strong>{value}</strong></div></article>; }
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
