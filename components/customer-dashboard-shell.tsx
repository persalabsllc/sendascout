import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { IconDashboard, IconSettings, IconTargetArrow, IconUser, IconWallet } from "@tabler/icons-react";
import { Brand } from "./brand";
import { MobileDashboardNav } from "./mobile-dashboard-nav";

export function CustomerDashboardShell({ active, name, children }: { active: "overview" | "payments" | "profile"; name: string; children: React.ReactNode }) {
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "CU";
  return <main className="dashboard-page"><aside className="dash-sidebar"><Brand /><nav>
    <Link className={active === "overview" ? "active" : ""} href="/dashboard/customer"><IconDashboard size={20} /> Overview</Link>
    <Link href="/dashboard/customer"><IconTargetArrow size={20} /> My missions</Link>
    <Link className={active === "payments" ? "active" : ""} href="/dashboard/customer/payments"><IconWallet size={20} /> Payments</Link>
    <Link className={active === "profile" ? "active" : ""} href="/dashboard/customer/profile"><IconUser size={20} /> Profile</Link>
  </nav><div className="dash-sidebar-bottom"><Link href="/dashboard/customer/profile"><IconSettings size={19} /> Settings</Link><div className="dash-user"><span>{initials}</span><div><strong>{name}</strong><small>Customer</small></div></div></div></aside><section className="dash-main"><header className="dash-header"><MobileDashboardNav initials={initials} name={name} role="customer" /><div><UserButton /></div></header><div className="dash-content">{children}</div></section></main>;
}
