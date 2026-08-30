import Link from "next/link";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { IconArrowRight, IconCreditCard, IconReceipt, IconShieldCheck } from "@tabler/icons-react";
import { CustomerDashboardShell } from "@/components/customer-dashboard-shell";
import { getDb } from "@/db";
import { missionBundles, missions } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Payments | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerPaymentsPage() {
  const user = await requireAppUser("customer");
  const db = getDb();
  const rows = await db.select().from(missions).where(and(eq(missions.customerId, user.id), isNull(missions.archivedAt))).orderBy(desc(missions.createdAt));
  const bundleIds = [...new Set(rows.flatMap((mission) => mission.bundleId ? [mission.bundleId] : []))];
  const bundleRows = bundleIds.length ? await db.select().from(missionBundles).where(inArray(missionBundles.id, bundleIds)) : [];
  const bundleById = new Map(bundleRows.map((bundle) => [bundle.id, bundle]));
  const displayRows = rows.filter((mission) => !mission.bundleId || mission.bundleSequence === bundleById.get(mission.bundleId)?.activeSequence).map((mission) => {
    const bundle = mission.bundleId ? bundleById.get(mission.bundleId) : null;
    return bundle ? {
      ...mission,
      title: bundle.title,
      status: bundle.status,
      customerPriceCents: bundle.customerPriceCents,
      listCustomerPriceCents: bundle.listCustomerPriceCents,
      bundleDiscountCents: bundle.bundleDiscountCents,
      paymentStatus: bundle.paymentStatus,
      createdAt: bundle.createdAt,
    } : mission;
  });
  const committed = displayRows.filter((mission) => !["draft", "cancelled"].includes(mission.status));
  const total = committed.reduce((sum, mission) => sum + mission.customerPriceCents, 0);
  const paid = committed.filter((mission) => mission.paymentStatus === "paid").reduce((sum, mission) => sum + mission.customerPriceCents, 0);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer";
  return <CustomerDashboardShell active="payments" name={name}><div className="dash-welcome simple-title"><div><span className="kicker">Customer billing</span><h1>Payments</h1><p>Mission charges and payment status in one place.</p></div></div><div className="stat-grid"><Stat icon={<IconReceipt size={22} />} label="Mission total" value={money(total)} note={`${committed.length} released mission${committed.length === 1 ? "" : "s"}`} /><Stat icon={<IconCreditCard size={22} />} label="Paid" value={money(paid)} note="Successfully processed payments" /><Stat icon={<IconShieldCheck size={22} />} label="Payment protection" value="Prepared" note="Activates with secure payments at launch" /></div><section className="dash-section"><div className="dash-section-title"><div><h2>Mission charges</h2><p>No card is charged while a mission remains a draft.</p></div></div>{displayRows.length ? <div className="mission-list">{displayRows.map((mission) => <Link className="mission-list-row" href={`/dashboard/missions/${mission.id}`} key={mission.id}><span className="list-icon"><IconReceipt size={21} /></span><div className="list-main"><small>{mission.bundleId ? "Multi-part mission" : mission.type === "see" ? "See It" : mission.type === "move" ? "Move It" : "Meet It"}</small><strong>{mission.title}</strong><span>{mission.createdAt.toLocaleDateString()}{mission.bundleDiscountCents > 0 ? ` · ${money(mission.bundleDiscountCents)} bundle savings` : ""}</span></div><div className="list-meta"><strong>{money(mission.customerPriceCents)}</strong><span className="status">{paymentLabel(mission.status, mission.paymentStatus)}</span></div><IconArrowRight className="list-arrow" size={18} /></Link>)}</div> : <div className="dashboard-empty"><p>Your mission charges will appear here.</p></div>}</section><div className="empty-prompt"><span><IconShieldCheck size={30} /></span><div><h3>Live card processing is not enabled yet</h3><p>This ledger is working now. Stripe authorization and refunds will be activated before the soft launch, so no test mission has charged your card.</p></div></div></CustomerDashboardShell>;
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) { return <article className="stat-card"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>; }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function paymentLabel(status: string, payment: string) { if (status === "draft") return "Not charged"; if (status === "cancelled") return "Cancelled"; return payment.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
