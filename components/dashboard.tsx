import Link from "next/link";
import {
  IconArrowRight,
  IconBell,
  IconCamera,
  IconCircleCheck,
  IconClock,
  IconCoin,
  IconDashboard,
  IconMapPin,
  IconMenu2,
  IconPlus,
  IconRoute,
  IconSettings,
  IconShieldCheck,
  IconTargetArrow,
  IconUser,
  IconWallet,
} from "@tabler/icons-react";
import { Brand } from "./brand";

type Role = "customer" | "scout";

const customerMissions = [
  { type: "See It", title: "Photograph used equipment", place: "New Bern, NC", status: "Scout matching", time: "Today", icon: IconCamera },
  { type: "Meet It", title: "Meet HVAC technician", place: "Kinston, NC", status: "Draft", time: "Friday", icon: IconClock },
];

const availableMissions = [
  { type: "See It", title: "Verify condition of boat motor", place: "New Bern, NC", distance: "4.8 mi", payout: "$30", icon: IconCamera },
  { type: "Move It", title: "Pick up electrical supply order", place: "Kinston → Dover", distance: "11.2 mi", payout: "$38", icon: IconRoute },
  { type: "Meet It", title: "Wait for appliance technician", place: "Havelock, NC", distance: "18.5 mi", payout: "$36", icon: IconClock },
];

export function Dashboard({ role }: { role: Role }) {
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
          <div className="dash-user"><span>KK</span><div><strong>Demo account</strong><small>{scout ? "Founding Scout" : "Customer"}</small></div></div>
        </div>
      </aside>

      <section className="dash-main">
        <header className="dash-header">
          <button aria-label="Open navigation"><IconMenu2 size={21} /></button>
          <div><span className="dash-alert"><IconBell size={20} /><i /></span><span className="dash-avatar">KK</span></div>
        </header>
        <div className="dash-content">
          <div className="dash-welcome">
            <div><span className="kicker">{scout ? "Scout command center" : "Customer dashboard"}</span><h1>{scout ? "Good afternoon, Scout." : "Good afternoon, Kyle."}</h1><p>{scout ? "Three nearby missions are ready to be claimed." : "Create a mission or follow along with one already underway."}</p></div>
            <Link className="button" href={scout ? "#missions" : "/request"}>{scout ? "Browse missions" : "New mission"} {scout ? <IconArrowRight size={19} /> : <IconPlus size={19} />}</Link>
          </div>

          {scout ? <ScoutOverview /> : <CustomerOverview />}
        </div>
      </section>
    </main>
  );
}

function CustomerOverview() {
  return <>
    <div className="stat-grid">
      <Stat icon={IconTargetArrow} label="Active missions" value="1" note="Scout matching" />
      <Stat icon={IconCircleCheck} label="Completed" value="0" note="Your history appears here" />
      <Stat icon={IconCoin} label="Account credit" value="$0" note="Credits never expire" />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Your missions</h2><p>Drafts and active work in one place.</p></div><Link href="/request">Create mission <IconArrowRight size={17} /></Link></div>
      <div className="mission-list">
        {customerMissions.map(({ icon: Icon, ...mission }) => <article key={mission.title}>
          <span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.type}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place}</span></div><div className="list-meta"><span className={`status ${mission.status === "Draft" ? "muted-status" : ""}`}>{mission.status}</span><small>{mission.time}</small></div><IconArrowRight className="list-arrow" size={19} />
        </article>)}
      </div>
    </section>
    <div className="empty-prompt"><span><IconShieldCheck size={30} /></span><div><h3>Payments activate at launch</h3><p>Customer payment will be authorized when a Scout accepts and released after successful completion.</p></div></div>
  </>;
}

function ScoutOverview() {
  return <>
    <div className="scout-banner"><span><IconShieldCheck size={26} /></span><div><strong>Founding Scout application</strong><p>Connect Clerk and Neon to begin identity verification and activate the live mission board.</p></div><span className="status">Setup pending</span></div>
    <div className="stat-grid scout-stats">
      <Stat icon={IconTargetArrow} label="Nearby missions" value="3" note="Within 25 miles" />
      <Stat icon={IconCoin} label="Available earnings" value="$104" note="Across open missions" />
      <Stat icon={IconRoute} label="Completed" value="0" note="Ready for your first" />
    </div>
    <section className="dash-section" id="missions">
      <div className="dash-section-title"><div><h2>Mission board</h2><p>Opportunities near your launch area.</p></div><button>Filter <IconSettings size={16} /></button></div>
      <div className="mission-list scout-list">
        {availableMissions.map(({ icon: Icon, ...mission }) => <article key={mission.title}>
          <span className="list-icon"><Icon size={22} /></span><div className="list-main"><small>{mission.type}</small><strong>{mission.title}</strong><span><IconMapPin size={14} /> {mission.place} · {mission.distance}</span></div><div className="payout"><small>Scout payout</small><strong>{mission.payout}</strong></div><button className="claim-button">View</button>
        </article>)}
      </div>
    </section>
  </>;
}

function Stat({ icon: Icon, label, value, note }: { icon: typeof IconTargetArrow; label: string; value: string; note: string }) {
  return <article className="stat-card"><span><Icon size={22} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}
