import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import {
  IconArrowRight, IconBell, IconCamera, IconCircleCheck, IconClock, IconCoin,
  IconDashboard, IconMapPin, IconPlus, IconRoute, IconSettings,
  IconShieldCheck, IconTargetArrow, IconUser, IconWallet,
} from "@tabler/icons-react";
import { Brand } from "./brand";
import { MobileDashboardNav } from "./mobile-dashboard-nav";

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
  assigned?: boolean;
};

export type DashboardNotification = {
  id: string;
  title: string;
  body: string;
  missionId?: string | null;
  createdAt: string;
};

export function Dashboard({
  role,
  userName,
  initials,
  missions = [],
  notifications = [],
  profileStatus = "applicant",
  showScoutBanner = true,
}: {
  role: Role;
  userName: string;
  initials: string;
  missions?: DashboardMission[];
  notifications?: DashboardNotification[];
  profileStatus?: string;
  showScoutBanner?: boolean;
}) {
  const scout = role === "scout";
  const scoutMission = scout
    ? missions.find((mission) => mission.assigned && !["completed", "cancelled", "disputed"].includes(mission.status))
      ?? missions.find((mission) => mission.status === "open")
    : undefined;
  return (
    <main className="dashboard-page">
      <aside className="dash-sidebar">
        <Brand />
        <nav>
          <Link className="active" href={scout ? "/dashboard/scout" : "/dashboard/customer"}><IconDashboard size={20} /> Overview</Link>
          <Link href={scout ? "/dashboard/scout/missions" : "/dashboard/customer"}><IconTargetArrow size={20} /> {scout ? "Mission board" : "My missions"}</Link>
          <Link href={scout ? "/dashboard/scout/earnings" : "/dashboard/customer/payments"}><IconWallet size={20} /> {scout ? "Earnings" : "Payments"}</Link>
          <Link href={scout ? "/dashboard/scout/settings" : "/dashboard/customer/profile"}><IconUser size={20} /> Profile</Link>
        </nav>
        <div className="dash-sidebar-bottom">
          <Link href={scout ? "/dashboard/scout/settings" : "/dashboard/customer/profile"}><IconSettings size={19} /> Settings</Link>
          <div className="dash-user"><span>{initials}</span><div><strong>{userName || "Your account"}</strong><small>{scout ? "Founding Scout" : "Customer"}</small></div></div>
        </div>
      </aside>

      <section className="dash-main">
        <header className="dash-header">
          <MobileDashboardNav initials={initials} name={userName} role={role} />
          <div><span className="dash-alert"><IconBell size={20} /></span><UserButton /></div>
        </header>
        <div className="dash-content">
          <div className="dash-welcome">
            <div><span className="kicker">{scout ? "Scout command center" : "Customer dashboard"}</span><h1>{userName ? `Welcome, ${userName}.` : "Welcome!"}</h1><p>{scout ? "Your application and nearby mission opportunities live here." : "Create a mission or follow along with one already underway."}</p></div>
            {scout
              ? scoutMission && <Link className="button" href={`/dashboard/missions/${scoutMission.id}`}>{scoutMission.assigned ? "Continue mission" : "Review next mission"} <IconArrowRight size={19} /></Link>
              : <Link className="button" href="/request">New mission <IconPlus size={19} /></Link>}
          </div>
          {notifications.length > 0 && <section className="notification-strip"><div><IconBell size={21} /><strong>{notifications[0].title}</strong><p>{notifications[0].body}</p></div>{notifications[0].missionId && <Link href={`/dashboard/missions/${notifications[0].missionId}`}>Open <IconArrowRight size={17} /></Link>}</section>}
          {scout ? <ScoutOverview missions={missions} profileStatus={profileStatus} showScoutBanner={showScoutBanner} /> : <CustomerOverview missions={missions} />}
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
        return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="list-meta"><span className={`status ${mission.status === "draft" ? "muted-status" : ""}`}>{statusLabel(mission.status)}</span><small>{mission.time}</small></div><IconArrowRight className="list-arrow" size={19} /></Link>;
      })}</div> : <EmptyMissions customer />}
    </section>
    <div className="empty-prompt" id="payments"><span><IconShieldCheck size={30} /></span><div><h3>Payments activate at launch</h3><p>Customer payment will be authorized when a Scout accepts and released after successful completion.</p></div></div>
  </>;
}

function ScoutOverview({ missions, profileStatus, showScoutBanner }: { missions: DashboardMission[]; profileStatus: string; showScoutBanner: boolean }) {
  const available = missions.filter((mission) => mission.status === "open" && !mission.assigned);
  const active = missions.filter((mission) => mission.assigned && !["completed", "cancelled", "disputed"].includes(mission.status));
  const completed = missions.filter((mission) => mission.assigned && mission.status === "completed");
  const missionBoard = [...active, ...available];
  const earned = completed.reduce((sum, mission) => sum + (mission.payoutCents ?? 0), 0);
  return <>
    {showScoutBanner && <div className="scout-banner"><span><IconShieldCheck size={26} /></span><div><strong>{profileStatus === "approved" ? "Application approved" : "Founding Scout application"}</strong><p>{profileStatus === "approved" ? "You’re approved and can claim matching missions in your delivery zone." : "Your application is saved. Identity and background verification will open before launch."}</p></div><span className="status">{statusLabel(profileStatus)}</span></div>}
    <div className="stat-grid scout-stats">
      <Stat icon={IconTargetArrow} label="Nearby missions" value={String(available.length)} note="Open launch-area missions" />
      <Stat icon={IconCoin} label="Earned" value={money(earned)} note="Completed mission payouts" />
      <Stat icon={IconRoute} label="Completed" value={String(completed.length)} note={completed.length ? "Your completed missions" : "Ready for your first"} />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Mission board</h2><p>Opportunities near your launch area.</p></div></div>
      {missionBoard.length ? <div className="mission-list scout-list">{missionBoard.map((mission) => {
        const Icon = iconFor(mission.type);
        return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.assigned ? `Your ${labelFor(mission.type)} mission` : labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="payout"><small>Scout payout</small><strong>{money(mission.payoutCents ?? 0)}</strong></div><span className="claim-button">{mission.assigned ? statusLabel(mission.status) : "Review"}</span></Link>;
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
function statusLabel(status: string) { return status === "draft" ? "Paused by support" : status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
