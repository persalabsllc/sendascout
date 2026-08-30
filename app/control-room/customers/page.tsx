import Link from "next/link";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { IconArrowLeft } from "@tabler/icons-react";
import { Brand } from "@/components/brand";
import { getDb } from "@/db";
import { missions, users } from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";

export const metadata = { title: "Customer Accounts | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerAccountsPage() {
  await requireAdminUser();
  const rows = await getDb().select({ user: users, missions: count(missions.id) }).from(users).leftJoin(missions, and(eq(missions.customerId, users.id), isNull(missions.archivedAt))).where(eq(users.role, "customer")).groupBy(users.id).orderBy(desc(users.createdAt));
  return <main className="control-page"><header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room">Control Room</Link><Link href="/">Public site</Link></div></header><div className="control-shell">
    <Link className="control-back" href="/control-room"><IconArrowLeft size={16} /> Marketplace operations</Link>
    <div className="control-title"><div><span className="kicker">Customer activity</span><h1>Customer accounts</h1><p>New and existing customer accounts with current marketplace activity.</p></div></div>
    <section className="control-section"><div className="control-section-title"><div><h2>All customers</h2><p>{rows.length} customer account{rows.length === 1 ? "" : "s"} · newest first</p></div></div>{rows.length ? <div className="control-table">{rows.map(({ user, missions: missionCount }) => <article key={user.id}><div className="control-primary"><strong>{[user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer"}</strong><span>{user.email} · {user.phone || "No phone"}</span><small>Joined {user.createdAt.toLocaleString()} · {missionCount} live mission{missionCount === 1 ? "" : "s"} · {user.legalAcceptedAt ? "Terms accepted" : "Terms pending"}</small></div><span className="status">{user.status}</span></article>)}</div> : <div className="control-empty">No customer accounts yet.</div>}</section>
  </div></main>;
}
