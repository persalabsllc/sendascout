import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { IconDashboard, IconSettings, IconTargetArrow, IconUser, IconWallet } from "@tabler/icons-react";
import { Brand } from "./brand";
import { MobileDashboardNav } from "./mobile-dashboard-nav";

export function ScoutDashboardShell({ active, name, children }: { active: "overview" | "missions" | "earnings" | "settings"; name: string; children: React.ReactNode }) {
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "SA";
  return <main className="dashboard-page"><aside className="dash-sidebar"><Brand /><nav>
    <Nav href="/dashboard/scout" label="Overview" active={active === "overview"} icon={<IconDashboard size={20} />} />
    <Nav href="/dashboard/scout/missions" label="Mission board" active={active === "missions"} icon={<IconTargetArrow size={20} />} />
    <Nav href="/dashboard/scout/earnings" label="Earnings" active={active === "earnings"} icon={<IconWallet size={20} />} />
    <Nav href="/dashboard/scout/settings" label="Profile" active={active === "settings"} icon={<IconUser size={20} />} />
  </nav><div className="dash-sidebar-bottom"><Link className={active === "settings" ? "active" : ""} href="/dashboard/scout/settings"><IconSettings size={19} /> Settings</Link><div className="dash-user"><span>{initials}</span><div><strong>{name}</strong><small>Founding Scout</small></div></div></div></aside>
  <section className="dash-main"><header className="dash-header"><MobileDashboardNav initials={initials} name={name} role="scout" /><div><UserButton /></div></header><div className="dash-content">{children}</div></section></main>;
}

function Nav({ href, label, icon, active }: { href: string; label: string; icon: React.ReactNode; active: boolean }) {
  return <Link className={active ? "active" : ""} href={href}>{icon}{label}</Link>;
}
