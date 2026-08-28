import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import {
  IconArrowRight, IconBell, IconCamera, IconCircleCheck, IconClock, IconCoin,
  IconDashboard, IconMapPin, IconMenu2, IconPlus, IconRoute, IconSettings,
  IconShieldCheck, IconTargetArrow, IconUser, IconWallet,
} from "@tabler/icons-react";
import { Brand } from "./brand";

type Role = "customer" | "scout";
type MissionKind = "see" | "move" | "meet";

export type DashboardMission = {
  id: string;
  type: MissionKind;
  title: string;
  place: string;
  status: string;
  time: string;
  payoutCents?: number;
};

export function Dashboard({
  role,
  userName,
  initials,
  missions = [],
  profileStatus = "applicant",
}: {
  role: Role;
  userName: string;
  initials: string;
  missions?: DashboardMission[];
  profileStatus?: string;
}) {
  const scout = role === "scout";
  return (
    <main className="dashboard-page">
      <aside className="dash-sidebar">
        <Brand />
        <nav>
          <Link className="active" href={scout ? "/dashboard/scout" : "/dashboard/customer"}><IconDashboard size={20} /> Overview</Link>
          <Link href="#missions"><IconTargetArrow size={20} /> {scout ? "Mission board" : "My missions"}</Link>
          <Link href="#payments"><IconWallet size={20} /> {scout ? "Earnings" : "Payments"}</Link>
          <Link href="#profile"><IconUser size={20} /> Profile</Link>
        </nav>
        <div className="dash-sidebar-bottom">
          <Link href="#settings"><IconSettings size={19} /> Settings</Link>
          <div className="dash-user"><span>{initials}</span><div><strong>{userName}</strong><small>{scout ? "Founding Scout" : "Customer"}</small></div></div>
        </div>
      </aside>

      <section className="dash-main">
        <header className="dash-header">
          <button aria-label="Open navigation"><IconMenu2 size={21} /></button>
          <div><span className="dash-alert"><IconBell size={20} /></span><UserButton /></div>
        </header>
        <div className="dash-content">
          <div className="dash-welcome">
            <div><span className="kicker">{scout ? "Scout command center" : "Customer dashboard"}</span><h1>{scout ? `Welcome, ${userName}.` : `Welcome, ${userName}.`}</h1><p>{scout ? "Your application and nearby mission opportunities live here." : "Create a mission or follow along with one already underway."}</p></div>
            <Link className="button" href={scout ? "#missions" : "/request"}>{scout ? "Browse missions" : "New mission"} {scout ? <IconArrowRight size={19} /> : <IconPlus size={19} />}</Link>
          </div>
          {scout ? <ScoutOverview missions={missions} profileStatus={profileStatus} /> : <CustomerOverview missions={missions} />}
        </div>
      </section>
    </main>
  );
}

function CustomerOverview({ missions }: { missions: DashboardMission[] }) {
  const active = missions.filter((mission) => !["completed", "cancelled"].includes(mission.status)).length;
  const completed = missions.filter((mission) => mission.status === "completed").length;
  return <>
    <div className="stat-grid">
      <Stat icon={IconTargetArrow} label="Active missions" value={String(active)} note={active ? "Drafts and active work" : "Create your first mission"} />
      <Stat icon={IconCircleCheck} label="Completed" value={String(completed)} note="Your completed history" />
      <Stat icon={IconCoin} label="Account credit" value="$0" note="Credits never expire" />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Your missions</h2><p>Drafts and active work in one place.</p></div><Link href="/request">Create mission <IconArrowRight size={17} /></Link></div>
      {missions.length ? <div className="mission-list">{missions.map((mission) => {
        const Icon = iconFor(mission.type);
        return <article key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="list-meta"><span className={`status ${mission.status === "draft" ? "muted-status" : ""}`}>{statusLabel(mission.status)}</span><small>{mission.time}</small></div><IconArrowRight className="list-arrow" size={19} /></article>;
      })}</div> : <EmptyMissions customer />}
    </section>
    <div className="empty-prompt" id="payments"><span><IconShieldCheck size={30} /></span><div><h3>Payments activate at launch</h3><p>Customer payment will be authorized when a Scout accepts and released after successful completion.</p></div></div>
  </>;
}

function ScoutOverview({ missions, profileStatus }: { missions: DashboardMission[]; profileStatus: string }) {
  const payout = missions.reduce((sum, mission) => sum + (mission.payoutCents ?? 0), 0);
  return <>
    <div className="scout-banner"><span><IconShieldCheck size={26} /></span><div><strong>Founding Scout application</strong><p>Your application is saved. Identity and background verification will open before launch.</p></div><span className="status">{statusLabel(profileStatus)}</span></div>
    <div className="stat-grid scout-stats">
      <Stat icon={IconTargetArrow} label="Nearby missions" value={String(missions.length)} note="Open launch-area missions" />
      <Stat icon={IconCoin} label="Available earnings" value={money(payout)} note="Across open missions" />
      <Stat icon={IconRoute} label="Completed" value="0" note="Ready for your first" />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Mission board</h2><p>Opportunities near your launch area.</p></div></div>
      {missions.length ? <div className="mission-list scout-list">{missions.map((mission) => {
        const Icon = iconFor(mission.type);
        return <article key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="payout"><small>Scout payout</small><strong>{money(mission.payoutCents ?? 0)}</strong></div><button className="claim-button" disabled>Coming soon</button></article>;
      })}</div> : <EmptyMissions />}
    </section>
  </>;
}

function EmptyMissions({ customer = false }: { customer?: boolean }) {
  return <div className="dashboard-empty"><IconTargetArrow size={30} /><h3>{customer ? "No missions yet" : "The mission board is warming up"}</h3><p>{customer ? "Create your first mission and it will appear here immediately." : "Approved Scouts will see launch-area missions here as customers post them."}</p>{customer && <Link className="button button-small" href="/request">Create a mission</Link>}</div>;
}

function Stat({ icon: Icon, label, value, note }: { icon: typeof IconTargetArrow; label: string; value: string; note: string }) { return <article className="stat-card"><span><Icon size={22} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>; }
function iconFor(type: MissionKind) { return type === "see" ? IconCamera : type === "move" ? IconRoute : IconClock; }
function labelFor(type: MissionKind) { return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It"; }
function statusLabel(status: string) { return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
