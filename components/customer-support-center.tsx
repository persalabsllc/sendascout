"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconCheck, IconLifebuoy, IconMessageCircle, IconReceiptRefund, IconSend } from "@tabler/icons-react";
import {
  createCustomerSupportTicket,
  customerAcceptSupportResolution,
  customerReplyToSupport,
} from "@/app/actions/support";
import {
  CUSTOMER_SUPPORT_REASONS,
  customerSupportReasonLabel,
  customerSupportResolutionLabel,
  type CustomerSupportReason,
  type CustomerSupportResolution,
} from "@/lib/customer-support-core";

export type CustomerSupportTicketView = {
  id: string;
  reason: CustomerSupportReason;
  summary: string;
  status: "open" | "awaiting_customer" | "closed";
  missionId: string | null;
  missionTitle: string | null;
  resolutionType: CustomerSupportResolution | null;
  resolutionAmountCents: number;
  resolutionNote: string | null;
  customerDecision: string | null;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; authorRole: "customer" | "admin"; authorName: string; body: string; createdAt: string }[];
};

type MissionOption = { id: string; title: string; label: string };

export function CustomerSupportCenter({ tickets, missions, creditBalanceCents }: { tickets: CustomerSupportTicketView[]; missions: MissionOption[]; creditBalanceCents: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reason, setReason] = useState<CustomerSupportReason>("mission_not_completed");
  const [missionId, setMissionId] = useState("");
  const [message, setMessage] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, successMessage: string, clear?: () => void) {
    setError("");
    setSuccess("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return setError(result.error);
      clear?.();
      setSuccess(successMessage);
      router.refresh();
    });
  }

  function openTicket() {
    run(
      () => createCustomerSupportTicket({ reason, missionId, message }),
      "Your support ticket is open. We’ll respond here and notify you when there is an update.",
      () => { setMessage(""); setMissionId(""); },
    );
  }

  function sendReply(ticketId: string, awaitingCustomer: boolean) {
    const body = replies[ticketId] ?? "";
    run(
      () => customerReplyToSupport(ticketId, body),
      awaitingCustomer ? "Your response was sent and the ticket is back with Support for review." : "Your reply was sent.",
      () => setReplies((current) => ({ ...current, [ticketId]: "" })),
    );
  }

  return <>
    <div className="support-summary-grid">
      <article><span><IconLifebuoy size={22} /></span><div><small>Open tickets</small><strong>{tickets.filter((ticket) => ticket.status !== "closed").length}</strong></div></article>
      <article><span><IconReceiptRefund size={22} /></span><div><small>Available account credit</small><strong>{money(creditBalanceCents)}</strong></div></article>
    </div>

    <section className="dash-section support-create-card">
      <div className="dash-section-title"><div><h2>Contact Support</h2><p>Tell us what happened and connect the ticket to a recent or open mission when applicable.</p></div></div>
      <div className="support-form-grid">
        <label className="field"><span>What can we help with?</span><select value={reason} onChange={(event) => setReason(event.target.value as CustomerSupportReason)}>{CUSTOMER_SUPPORT_REASONS.map((value) => <option value={value} key={value}>{customerSupportReasonLabel(value)}</option>)}</select></label>
        <label className="field"><span>Related mission</span><select value={missionId} onChange={(event) => setMissionId(event.target.value)}><option value="">Not related to a mission</option>{missions.map((mission) => <option value={mission.id} key={mission.id}>{mission.title} · {mission.label}</option>)}</select><small>Open and recent missions appear here.</small></label>
        <label className="field support-message-field"><span>Briefly describe the issue</span><textarea rows={5} minLength={10} maxLength={3000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Include the facts Support needs to review. Do not enter card numbers or government ID information." /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="form-success" role="status">{success}</p>}
      <button className="button" disabled={pending || message.trim().length < 10} onClick={openTicket}>{pending ? "Submitting…" : "Open support ticket"}<IconSend size={17} /></button>
    </section>

    <section className="dash-section">
      <div className="dash-section-title"><div><h2>Your support tickets</h2><p>Replies and proposed resolutions stay attached to the ticket for a clear record.</p></div></div>
      {tickets.length ? <div className="support-ticket-list">{tickets.map((ticket) => {
        const awaitingCustomer = ticket.status === "awaiting_customer";
        const approvedResolution = ticket.status === "closed" && ticket.customerDecision === "approved";
        return <article className="support-ticket" key={ticket.id}>
          <div className="support-ticket-heading"><div><small>{customerSupportReasonLabel(ticket.reason)} · Ticket {ticket.id.slice(0, 8).toUpperCase()}</small><h3>{ticket.missionTitle ?? "General customer support"}</h3><p>Opened {new Date(ticket.createdAt).toLocaleString()}</p></div><span className={`status ${awaitingCustomer ? "warning-status" : ticket.status === "closed" ? "" : "muted-status"}`}>{supportStatus(ticket.status)}</span></div>
          {ticket.missionId && <Link className="support-mission-link" href={`/dashboard/missions/${ticket.missionId}`}>View related mission</Link>}
          <div className="support-thread">{ticket.messages.map((entry) => <div className={`support-message ${entry.authorRole}`} key={entry.id}><div><strong>{entry.authorName}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small></div><p>{entry.body}</p></div>)}</div>
          {(awaitingCustomer || approvedResolution) && ticket.resolutionType && ticket.resolutionNote && <div className={`support-resolution-card ${awaitingCustomer ? "pending" : "approved"}`}><span><IconReceiptRefund size={24} /></span><div><small>{awaitingCustomer ? "Proposed resolution" : "Approved resolution"}</small><h4>{customerSupportResolutionLabel(ticket.resolutionType)} · {money(ticket.resolutionAmountCents)}</h4><p>{ticket.resolutionNote}</p>{awaitingCustomer ? <p>Your approval is required before this ticket closes. If this does not resolve the issue, send a reply below and it will return to Support.</p> : <p><IconCheck size={15} /> You approved this resolution and the ticket is closed.</p>}</div>{awaitingCustomer && <button className="button button-small" disabled={pending} onClick={() => run(() => customerAcceptSupportResolution(ticket.id), "Resolution approved. Your ticket is now closed.")}>Approve resolution</button>}</div>}
          {ticket.status !== "closed" && <div className="support-reply"><label className="field"><span>{awaitingCustomer ? "Need a different resolution? Tell us why" : "Reply to Support"}</span><textarea rows={3} minLength={10} maxLength={3000} value={replies[ticket.id] ?? ""} onChange={(event) => setReplies((current) => ({ ...current, [ticket.id]: event.target.value }))} placeholder={awaitingCustomer ? "Explain what still needs to be addressed…" : "Add information or answer Support’s question…"} /></label><button className="button button-ghost button-small" disabled={pending || (replies[ticket.id] ?? "").trim().length < 10} onClick={() => sendReply(ticket.id, awaitingCustomer)}>{awaitingCustomer ? "Request another review" : "Send reply"}<IconMessageCircle size={16} /></button></div>}
        </article>;
      })}</div> : <div className="dashboard-empty"><IconLifebuoy size={31} /><h3>No support tickets yet</h3><p>Use the form above whenever you need help with your customer account or a mission.</p></div>}
    </section>
  </>;
}

function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function supportStatus(status: CustomerSupportTicketView["status"]) { return status === "awaiting_customer" ? "Your approval needed" : status === "closed" ? "Closed" : "Open"; }
