"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconCheck, IconMessageCircle, IconReceiptRefund, IconSend } from "@tabler/icons-react";
import { adminProposeCustomerSupportResolution, adminReplyToCustomerSupport } from "@/app/actions/support";
import { customerSupportReasonLabel, customerSupportResolutionLabel, type CustomerSupportReason, type CustomerSupportResolution } from "@/lib/customer-support-core";

export type AdminSupportTicketView = {
  id: string;
  customer: string;
  customerEmail: string;
  reason: CustomerSupportReason;
  status: "open" | "awaiting_customer" | "closed";
  missionId: string | null;
  missionTitle: string | null;
  maximumRefundCents: number;
  resolutionType: CustomerSupportResolution | null;
  resolutionAmountCents: number;
  resolutionNote: string | null;
  customerDecision: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; authorRole: "customer" | "admin"; authorName: string; body: string; createdAt: string }[];
};

export function ControlRoomSupport({ tickets }: { tickets: AdminSupportTicketView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [resolutionTypes, setResolutionTypes] = useState<Record<string, CustomerSupportResolution>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, clear?: () => void) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return setError(result.error);
      clear?.();
      router.refresh();
    });
  }

  function sendReply(ticketId: string) {
    run(() => adminReplyToCustomerSupport(ticketId, replies[ticketId] ?? ""), () => setReplies((current) => ({ ...current, [ticketId]: "" })));
  }

  function propose(ticket: AdminSupportTicketView) {
    const resolution = resolutionTypes[ticket.id] ?? (ticket.missionId ? "full_refund" : "account_credit");
    const amountCents = resolution === "full_refund" ? ticket.maximumRefundCents : centsFromInput(amounts[ticket.id] ?? "");
    if (amountCents === null) return setError("Enter a valid dollar amount for the proposed resolution.");
    run(() => adminProposeCustomerSupportResolution(ticket.id, resolution, amountCents, notes[ticket.id] ?? ""));
  }

  const activeCount = tickets.filter((ticket) => ticket.status !== "closed").length;
  return <>
    <div className="control-stats support-control-stats">
      <article><span><IconMessageCircle size={22} /></span><div><small>Active customer tickets</small><strong>{activeCount}</strong></div></article>
      <article><span><IconCheck size={22} /></span><div><small>Closed tickets</small><strong>{tickets.length - activeCount}</strong></div></article>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="control-section">
      <div className="control-section-title"><div><h2>Customer support inbox</h2><p>Reply to customers or propose a refund or Send a Scout credit. The customer must approve the proposal before the ticket closes.</p></div></div>
      {tickets.length ? <div className="admin-support-list">{tickets.map((ticket) => {
        const resolution = resolutionTypes[ticket.id] ?? (ticket.missionId ? "full_refund" : "account_credit");
        return <article className="admin-support-ticket" key={ticket.id}>
          <div className="support-ticket-heading"><div><small>{customerSupportReasonLabel(ticket.reason)} · {ticket.customer}</small><h3>{ticket.missionTitle ?? "General customer support"}</h3><p>{ticket.customerEmail} · Opened {new Date(ticket.createdAt).toLocaleString()} · Ticket {ticket.id.slice(0, 8).toUpperCase()}</p></div><span className={`status ${ticket.status === "awaiting_customer" ? "warning-status" : ticket.status === "closed" ? "" : "muted-status"}`}>{statusLabel(ticket.status)}</span></div>
          {ticket.missionId && <Link className="support-mission-link" href={`/dashboard/missions/${ticket.missionId}`}>Review mission record <IconArrowRight size={14} /></Link>}
          <div className="support-thread">{ticket.messages.map((entry) => <div className={`support-message ${entry.authorRole}`} key={entry.id}><div><strong>{entry.authorName}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small></div><p>{entry.body}</p></div>)}</div>
          {ticket.resolutionType && ticket.resolutionNote && <div className={`support-resolution-card ${ticket.status === "closed" ? "approved" : "pending"}`}><span><IconReceiptRefund size={23} /></span><div><small>{ticket.status === "closed" ? "Customer-approved resolution" : "Resolution awaiting customer"}</small><h4>{customerSupportResolutionLabel(ticket.resolutionType)} · {money(ticket.resolutionAmountCents)}</h4><p>{ticket.resolutionNote}</p>{ticket.customerDecision === "needs_review" && <p>The customer requested another review after this proposal.</p>}</div></div>}
          {ticket.status !== "closed" && <div className="admin-support-actions">
            <div className="support-admin-reply"><label><span>Reply without resolving</span><textarea rows={3} minLength={10} maxLength={3000} value={replies[ticket.id] ?? ""} onChange={(event) => setReplies((current) => ({ ...current, [ticket.id]: event.target.value }))} placeholder="Ask a question or give the customer an update…" /></label><button className="button button-ghost button-small" disabled={pending || (replies[ticket.id] ?? "").trim().length < 10} onClick={() => sendReply(ticket.id)}>Send reply <IconSend size={15} /></button></div>
            <div className="support-admin-resolution"><label><span>Resolution</span><select value={resolution} onChange={(event) => setResolutionTypes((current) => ({ ...current, [ticket.id]: event.target.value as CustomerSupportResolution }))}><option value="full_refund" disabled={!ticket.missionId}>Full refund</option><option value="partial_refund" disabled={!ticket.missionId}>Partial refund</option><option value="account_credit">Send a Scout credit</option></select></label><label><span>Amount</span><input inputMode="decimal" min="0.01" step="1" type="number" disabled={resolution === "full_refund"} value={resolution === "full_refund" ? (ticket.maximumRefundCents / 100).toFixed(2) : amounts[ticket.id] ?? ""} onChange={(event) => setAmounts((current) => ({ ...current, [ticket.id]: event.target.value }))} placeholder="0.00" /></label><label className="support-resolution-note"><span>Customer-facing explanation</span><textarea rows={3} minLength={10} maxLength={3000} value={notes[ticket.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [ticket.id]: event.target.value }))} placeholder="Explain the determination clearly and what the customer is approving." /></label><button className="button button-small" disabled={pending || (notes[ticket.id] ?? "").trim().length < 10 || (resolution !== "full_refund" && !amounts[ticket.id])} onClick={() => propose(ticket)}>Send resolution for approval</button><small>Refunds are recorded for payment processing. Account credit is issued only after customer approval.</small></div>
          </div>}
        </article>;
      })}</div> : <div className="control-empty">No customer support tickets have been submitted.</div>}
    </section>
  </>;
}

function centsFromInput(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function statusLabel(status: AdminSupportTicketView["status"]) { return status === "awaiting_customer" ? "Awaiting customer" : status === "closed" ? "Closed" : "Open"; }
