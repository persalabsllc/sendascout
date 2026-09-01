import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import {
  IconArrowRight, IconBell, IconCamera, IconCircleCheck, IconClock, IconCoin,
  IconBook2, IconBuildingStore, IconCalendarRepeat, IconDashboard, IconLifebuoy, IconMapPin, IconPlus, IconRoute, IconSettings,
  IconShieldCheck, IconTargetArrow, IconUser, IconWallet,
} from "@tabler/icons-react";
import { Brand } from "./brand";
import { MobileDashboardNav } from "./mobile-dashboard-nav";
import { ScoutPayoutRequiredBanner } from "./scout-payout-required-banner";
import { ScoutHandbookRequiredBanner } from "./scout-handbook-required-banner";

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
  bundleParts?: number;
  bundleLabel?: string;
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
  scoutPayoutReady = true,
  scoutHandbookAccepted = true,
}: {
  role: Role;
  userName: string;
  initials: string;
  missions?: DashboardMission[];
  notifications?: DashboardNotification[];
  profileStatus?: string;
  showScoutBanner?: boolean;
  scoutPayoutReady?: boolean;
  scoutHandbookAccepted?: boolean;
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
          {scout && <Link href="/dashboard/scout/handbook"><IconBook2 size={20} /> Scout Handbook</Link>}
          {!scout && <Link href="/dashboard/customer/saved"><IconCalendarRepeat size={20} /> Saved &amp; recurring</Link>}
          {!scout && <Link href="/dashboard/customer/business"><IconBuildingStore size={20} /> Business</Link>}
          <Link href={scout ? "/dashboard/scout/earnings" : "/dashboard/customer/payments"}><IconWallet size={20} /> {scout ? "Earnings" : "Payments"}</Link>
          <Link href={scout ? "/dashboard/scout/settings" : "/dashboard/customer/profile"}><IconUser size={20} /> Profile</Link>
        </nav>
        <div className="dash-sidebar-bottom">
          {!scout && <Link href="/dashboard/customer/support"><IconLifebuoy size={19} /> Contact Support</Link>}
          <Link href={scout ? "/dashboard/scout/settings" : "/dashboard/customer/profile"}><IconSettings size={19} /> Settings</Link>
          <div className="dash-user"><span>{initials}</span><div><strong>{userName || "Your account"}</strong><small>{scout ? "Founding Scout" : "Customer"}</small></div></div>
        </div>
      </aside>

      <section className="dash-main">
        <header className="dash-header">
          <MobileDashboardNav initials={initials} name={userName} role={role} />
          <div><Link aria-label={`Notifications${notifications.length ? `, ${notifications.length} unread` : ""}`} className={`dash-alert ${notifications.length ? "has-alerts" : ""}`} href="/dashboard/notifications"><IconBell size={20} />{notifications.length > 0 && <span>{notifications.length > 9 ? "9+" : notifications.length}</span>}</Link><UserButton /></div>
        </header>
        <div className="dash-content">
          <div className="dash-welcome">
            <div><span className="kicker">{scout ? "Scout command center" : "Customer dashboard"}</span><h1>{userName ? `Welcome, ${userName}.` : "Welcome!"}</h1><p>{scout ? "Your application and nearby mission opportunities live here." : "Create a mission or follow along with one already underway."}</p></div>
            {scout
              ? scoutMission && <Link className="button" href={`/dashboard/missions/${scoutMission.id}`}>{scoutMission.assigned ? "Continue mission" : "Review next mission"} <IconArrowRight size={19} /></Link>
              : <Link className="button" href="/request">New mission <IconPlus size={19} /></Link>}
          </div>
          {notifications.length > 0 && <section className="notification-strip"><div><IconBell size={21} /><strong>{notifications[0].title}</strong><p>{notifications[0].body}</p></div><Link href={notifications[0].missionId ? `/dashboard/missions/${notifications[0].missionId}` : "/dashboard/notifications"}>{notifications[0].missionId ? "Open" : "View all"} <IconArrowRight size={17} /></Link></section>}
          {scout ? <ScoutOverview missions={missions} profileStatus={profileStatus} showScoutBanner={showScoutBanner} scoutPayoutReady={scoutPayoutReady} scoutHandbookAccepted={scoutHandbookAccepted} /> : <CustomerOverview missions={missions} />}
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
        return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.bundleLabel ?? labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="list-meta"><span className={`status ${mission.status === "draft" ? "muted-status" : ""}`}>{statusLabel(mission.status)}</span><small>{mission.time}</small></div><IconArrowRight className="list-arrow" size={19} /></Link>;
      })}</div> : <EmptyMissions customer />}
    </section>
    <div className="empty-prompt"><span><IconCalendarRepeat size={30} /></span><div><h3>Saved missions and repeat schedules</h3><p>Reuse a template, review recurring work, or book a completed mission again.</p></div><Link className="button button-ghost button-small" href="/dashboard/customer/saved">Open saved</Link></div>
    <div className="empty-prompt" id="payments"><span><IconShieldCheck size={30} /></span><div><h3>Payments activate at launch</h3><p>Customer payment will be authorized when a Scout accepts and released after successful completion.</p></div></div>
  </>;
}

function ScoutOverview({ missions, profileStatus, showScoutBanner, scoutPayoutReady, scoutHandbookAccepted }: { missions: DashboardMission[]; profileStatus: string; showScoutBanner: boolean; scoutPayoutReady: boolean; scoutHandbookAccepted: boolean }) {
  const canBrowseOpen = ["applicant", "review", "approved"].includes(profileStatus);
  const available = missions.filter((mission) => mission.status === "open" && !mission.assigned);
  const active = missions.filter((mission) => mission.assigned && !["completed", "cancelled", "disputed"].includes(mission.status));
  const completed = missions.filter((mission) => mission.assigned && mission.status === "completed");
  const missionBoard = [...active, ...available];
  const earned = completed.reduce((sum, mission) => sum + (mission.payoutCents ?? 0), 0);
  return <>
    {showScoutBanner && <div className="scout-banner"><span><IconShieldCheck size={26} /></span><div><strong>{profileStatus === "approved" ? "Application approved" : profileStatus === "paused" ? "Scout access paused" : profileStatus === "rejected" ? "Application status" : "Founding Scout application"}</strong><p>{profileStatus === "paused" ? "New opportunities are hidden while Control Room reviews your account. Assigned work remains available." : profileStatus === "rejected" ? "This application is not eligible for new mission opportunities. Contact support if you believe this is an error." : profileStatus === "approved" ? !scoutHandbookAccepted ? "You can browse matching missions now. Review the Scout Handbook before claiming one." : scoutPayoutReady ? "You’re approved and can claim matching missions in your delivery zone." : "You can browse matching missions now. Finish payout setup before claiming one." : "Your application is saved. You can browse matching opportunities while finishing the requirements to claim."}</p></div><span className="status">{statusLabel(profileStatus)}</span></div>}
    {canBrowseOpen && !scoutHandbookAccepted && <ScoutHandbookRequiredBanner />}
    {canBrowseOpen && !scoutPayoutReady && <ScoutPayoutRequiredBanner applicationApproved={profileStatus === "approved"} />}
    <div className="stat-grid scout-stats">
      <Stat icon={IconTargetArrow} label="Nearby missions" value={String(available.length)} note={profileStatus === "paused" || profileStatus === "rejected" ? "New opportunities are hidden" : "Open missions in your area"} />
      <Stat icon={IconCoin} label="Earned" value={money(earned)} note="Completed mission payouts" />
      <Stat icon={IconRoute} label="Completed" value={String(completed.length)} note={completed.length ? "Your completed missions" : "Ready for your first"} />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Mission board</h2><p>Opportunities within your selected service area.</p></div></div>
      {missionBoard.length ? <div className="mission-list scout-list">{missionBoard.map((mission) => {
        const Icon = iconFor(mission.type);
        return <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.assigned ? `Your ${labelFor(mission.type)} mission` : labelFor(mission.type)}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="payout"><small>You&apos;ll earn</small><strong>{money(mission.payoutCents ?? 0)}</strong></div><span className="claim-button">{mission.assigned ? statusLabel(mission.status) : "Review"}</span></Link>;
      })}</div> : <EmptyMissions profileStatus={profileStatus} />}
    </section>
  </>;
}

function EmptyMissions({ customer = false, profileStatus }: { customer?: boolean; profileStatus?: string }) {
  const scoutHeading = profileStatus === "paused" ? "New opportunities are paused" : profileStatus === "rejected" ? "No new mission access" : "The mission board is warming up";
  const scoutCopy = profileStatus === "paused"
    ? "Assigned work remains available, but new opportunities stay hidden until Control Room restores access."
    : profileStatus === "rejected"
      ? "This application is not eligible for new mission opportunities. Contact support if you believe this is an error."
      : "Matching nearby opportunities will appear here as customers post them. Complete onboarding to claim one.";
  return <div className="dashboard-empty"><IconTargetArrow size={30} /><h3>{customer ? "No missions yet" : scoutHeading}</h3><p>{customer ? "Create your first mission and it will appear here immediately." : scoutCopy}</p>{customer && <Link className="button button-small" href="/request">Create mission</Link>}</div>;
}

function Stat({ icon: Icon, label, value, note }: { icon: typeof IconTargetArrow; label: string; value: string; note: string }) { return <article className="stat-card"><span><Icon size={22} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>; }
function iconFor(type: MissionKind) { return type === "see" ? IconCamera : type === "move" ? IconRoute : IconClock; }
function labelFor(type: MissionKind) { return type === "see" ? "See It" : type === "move" ? "Move It" : "Meet It"; }
function statusLabel(status: string) { return status === "draft" ? "Paused by support" : status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
