import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { IconArrowRight, IconCreditCard, IconReceipt, IconShieldCheck } from "@tabler/icons-react";
import { ContinuePaymentButton } from "@/components/continue-payment-button";
import { CustomerDashboardShell } from "@/components/customer-dashboard-shell";
import { getDb } from "@/db";
import { missionBundles, missions, payments } from "@/db/schema";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Payments | Send a Scout", robots: { index: false, follow: false } };

const recoverableStatuses = new Set(["pending", "requires_action", "failed", "canceled"]);

export default async function CustomerPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const user = await requireAppUser("customer");
  const { checkout } = await searchParams;
  const ledger = await getDb().select({
    payment: payments,
    missionTitle: missions.title,
    missionType: missions.type,
    bundleTitle: missionBundles.title,
  }).from(payments)
    .innerJoin(missions, eq(missions.id, payments.missionId))
    .leftJoin(missionBundles, eq(missionBundles.id, payments.bundleId))
    .where(eq(payments.customerId, user.id))
    .orderBy(desc(payments.createdAt));

  const requestedCents = ledger.reduce((sum, row) => sum + row.payment.amountCents, 0);
  const collectedCents = ledger.filter((row) => ["paid", "partially_refunded", "refunded", "disputed"].includes(row.payment.status))
    .reduce((sum, row) => sum + row.payment.amountCents - row.payment.refundedAmountCents, 0);
  const attentionCents = ledger.filter((row) => recoverableStatuses.has(row.payment.status))
    .reduce((sum, row) => sum + row.payment.amountCents, 0);
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "Customer";

  return <CustomerDashboardShell active="payments" name={name}>
    <div className="dash-welcome simple-title"><div><span className="kicker">Customer billing</span><h1>Payments</h1><p>Every booking, supplement, additional task, and tip in one secure ledger.</p></div></div>
    {checkout === "success" && <div className="notification-strip" role="status"><div><IconShieldCheck size={24} /><strong>Payment submitted</strong><p>Stripe is confirming the payment. Its status below will update as soon as confirmation finishes.</p></div></div>}
    {checkout === "cancelled" && <div className="notification-strip" role="status"><div><IconCreditCard size={24} /><strong>Checkout canceled</strong><p>No new payment was completed. You can continue securely from the ledger below.</p></div></div>}
    <div className="stat-grid">
      <Stat icon={<IconReceipt size={22} />} label="Requested" value={money(requestedCents)} note={`${ledger.length} payment entr${ledger.length === 1 ? "y" : "ies"}`} />
      <Stat icon={<IconCreditCard size={22} />} label="Collected" value={money(collectedCents)} note="After completed refunds" />
      <Stat icon={<IconShieldCheck size={22} />} label="Needs attention" value={money(attentionCents)} note="Secure checkout powered by Stripe" />
    </div>
    <section className="dash-section">
      <div className="dash-section-title"><div><h2>Payment ledger</h2><p>Mission access is released only after its booking payment is confirmed.</p></div></div>
      {ledger.length ? <div className="mission-list">{ledger.map(({ payment, missionTitle, missionType, bundleTitle }) => {
        const canContinue = recoverableStatuses.has(payment.status);
        return <article className="mission-list-row" key={payment.id}>
          <span className="list-icon"><IconReceipt size={21} /></span>
          <div className="list-main">
            <small>{paymentKindLabel(payment.kind)}</small>
            <strong><Link href={`/dashboard/missions/${payment.missionId}`}>{bundleTitle ?? missionTitle}</Link></strong>
            <span>{missionTypeLabel(missionType)} · {payment.createdAt.toLocaleDateString()}</span>
            <span>{paymentStatusNote(payment.status)}{payment.refundedAmountCents > 0 ? ` · ${money(payment.refundedAmountCents)} refunded` : ""}</span>
          </div>
          <div className="list-meta">
            <strong>{money(payment.amountCents)}</strong>
            <span className={`status ${["failed", "canceled", "refunded"].includes(payment.status) ? "muted-status" : ""}`}>{paymentStatusLabel(payment.status)}</span>
          </div>
          {canContinue ? <ContinuePaymentButton paymentId={payment.id} /> : <Link className="list-arrow" href={`/dashboard/missions/${payment.missionId}`} aria-label={`View ${bundleTitle ?? missionTitle}`}><IconArrowRight size={18} /></Link>}
        </article>;
      })}</div> : <div className="dashboard-empty"><IconReceipt size={30} /><h3>No payments yet</h3><p>Your booking and additional mission payments will appear here.</p><Link className="button button-small" href="/request">Create a mission</Link></div>}
    </section>
    <div className="empty-prompt"><span><IconShieldCheck size={30} /></span><div><h3>Payments stay protected by Stripe</h3><p>Card details are entered on Stripe’s secure checkout. Send a Scout stores the resulting transaction record, not your full card number.</p></div></div>
  </CustomerDashboardShell>;
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function missionTypeLabel(type: string) {
  if (type === "see") return "See It";
  if (type === "move") return "Move It";
  return "Meet It";
}

function paymentKindLabel(kind: string) {
  if (kind === "booking") return "Booking payment";
  if (kind === "meet_adjustment") return "Mission supplement";
  if (kind === "change_order") return "Additional task";
  if (kind === "tip") return "Scout tip";
  if (kind === "duplicate") return "Duplicate charge refund";
  return "Payment adjustment";
}

function paymentStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "Pending",
    requires_action: "Action needed",
    processing: "Processing",
    authorized: "Authorized",
    paid: "Paid",
    partially_refunded: "Partially refunded",
    refunded: "Refunded",
    failed: "Failed",
    canceled: "Canceled",
    disputed: "Under review",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function paymentStatusNote(status: string) {
  const notes: Record<string, string> = {
    pending: "Checkout is ready to continue",
    requires_action: "Stripe needs payment confirmation",
    processing: "Stripe is confirming this payment",
    authorized: "Payment is authorized",
    paid: "Payment collected",
    partially_refunded: "A partial refund was issued",
    refunded: "This payment was refunded",
    failed: "Payment was not completed",
    canceled: "Checkout was canceled",
    disputed: "This payment is under review",
  };
  return notes[status] ?? "Payment status updated";
}
