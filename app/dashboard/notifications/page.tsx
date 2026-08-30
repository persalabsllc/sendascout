import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { desc, eq, and } from "drizzle-orm";
import { IconArrowLeft, IconBell } from "@tabler/icons-react";
import { Brand } from "@/components/brand";
import { MobileDashboardNav } from "@/components/mobile-dashboard-nav";
import { NotificationCenter } from "@/components/notification-center";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Notifications | Send a Scout", robots: { index: false, follow: false } };

export default async function NotificationsPage() {
  const user = await requireAppUser("customer");
  const role = user.role === "scout" ? "scout" as const : "customer" as const;
  const rows = await getDb().select().from(notifications)
    .where(and(eq(notifications.recipientUserId, user.id), eq(notifications.channel, "in_app")))
    .orderBy(desc(notifications.createdAt)).limit(100);
  const name = user.firstName || (role === "scout" ? "Scout" : "Customer");
  const initials = `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "SA";
  const home = role === "scout" ? "/dashboard/scout" : "/dashboard/customer";
  return <main className="dashboard-page">
    <aside className="dash-sidebar notification-sidebar"><Brand /><Link href={home}><IconArrowLeft size={19} /> Back to overview</Link></aside>
    <section className="dash-main">
      <header className="dash-header"><MobileDashboardNav initials={initials} name={name} role={role} /><div><Link aria-label="Notifications" className="dash-alert active" href="/dashboard/notifications"><IconBell size={20} /></Link><UserButton /></div></header>
      <div className="dash-content"><div className="dash-welcome simple-title"><div><span className="kicker">Account updates</span><h1>Your notifications</h1><p>Mission alerts, status changes and important account notices in one place.</p></div></div>
        <NotificationCenter items={rows.map((item) => ({ id: item.id, title: item.title, body: item.body, actionUrl: item.actionUrl ?? (item.missionId ? `/dashboard/missions/${item.missionId}` : null), actionLabel: item.actionLabel, readAt: item.readAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() }))} />
      </div>
    </section>
  </main>;
}
