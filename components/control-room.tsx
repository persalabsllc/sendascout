"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconAlertTriangle, IconArrowRight, IconBook2, IconBriefcase, IconCheck, IconLifebuoy, IconMail, IconRefresh, IconRoute, IconUserPlus, IconUsers } from "@tabler/icons-react";
import { adminSetMissionStatus } from "@/app/actions/missions";
import { adminArchiveMission, adminResolveMissionCase, adminRetryNotification, adminSetOperationalEventStatus } from "@/app/actions/operations";
import { Brand } from "./brand";

type MissionRow = { id: string; title: string; type: string; status: string; paymentStatus: string; customer: string; location: string; price: number; payout: number; routeMiles: number | null; routeVerified: boolean; authorizedMinutes: number; createdAt: string };
type CaseRow = { id: string; missionId: string; missionTitle: string; kind: string; status: string; previousMissionStatus: string; summary: string; reporter: string; adminNotes: string | null; resolution: string | null; refundAmountCents: number; payoutAmountCents: number; financialApprovalPending: boolean; proposedByCurrentAdmin: boolean; createdAt: string; resolvedAt: string | null; customerPriceCents: number; scoutPayoutCents: number };
type MessageRow = { id: string; channel: string; recipient: string; title: string; status: string; error: string | null; attempts: number; createdAt: string; sentAt: string | null };
type OperationalEventRow = { id: string; severity: string; category: string; message: string; status: string; occurrenceCount: number; lastSeenAt: string; alertedAt: string | null };

export function ControlRoom({ stats, missions, cases, messageNotifications, operationalEvents, sentMode }: { stats: { newCustomers: number; newScouts: number; open: number; active: number; cases: number; failedMessages: number }; missions: MissionRow[]; cases: CaseRow[]; messageNotifications: MessageRow[]; operationalEvents: OperationalEventRow[]; sentMode: "Disabled" | "Sandbox" | "Live" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }
  return <main className="control-page">
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room/analytics">Analytics</Link><Link href="/control-room/customers">Customers</Link><Link href="/control-room/scouts">Scouts</Link><Link href="/control-room/support">Support</Link><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <div className="control-title"><div><span className="kicker">Send a Scout Control Room</span><h1>Marketplace operations</h1><p>Approve Scouts, release missions and oversee every active job.</p></div><div className="control-title-actions"><Link className="button button-small button-ghost" href="/control-room/support"><IconLifebuoy size={17} /> Customer support</Link><Link className="button button-small" href="/control-room/procedures"><IconBook2 size={17} /> Operations playbook</Link></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="control-stats">
        <ControlStat alert={stats.newCustomers > 0} href="/control-room/customers" icon={IconUserPlus} label="New customers · 24h" value={stats.newCustomers} />
        <ControlStat alert={stats.newScouts > 0} href="/control-room/scouts" icon={IconUsers} label="New Scouts · 24h" value={stats.newScouts} />
        <ControlStat icon={IconBriefcase} label="Open missions" value={stats.open} />
        <ControlStat icon={IconRoute} label="Active missions" value={stats.active} />
        <ControlStat icon={IconAlertTriangle} label="Open cases" value={stats.cases} />
        <ControlStat icon={IconMail} label="Failed messages" value={stats.failedMessages} />
      </div>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Mission queue</h2><p>New missions publish automatically. Pull an unclaimed mission when it needs review or correction.</p></div></div>
        {missions.length ? <div className="control-table mission-admin-list">{missions.map((mission) => <article key={mission.id}>
          <div className="control-primary"><small>{titleCase(mission.type)} It · {mission.customer}</small><strong>{mission.title}</strong><span>{mission.location} · Customer {money(mission.price)} · Scout {money(mission.payout)}</span><small>{mission.type === "move" ? mission.routeVerified && mission.routeMiles ? `${mission.routeMiles} road miles · Google-verified route` : "Route verification required before release" : mission.type === "meet" ? `${mission.authorizedMinutes / 60}-hour customer authorization` : "Fixed-price mission"}</small></div>
          <span className={`status ${mission.status === "draft" ? "muted-status" : ""}`}>{mission.status === "draft" ? "Pulled" : titleCase(mission.status)}</span>
          <div className="control-actions">
            <Link href={`/dashboard/missions/${mission.id}`}>Open <IconArrowRight size={16} /></Link>
            {mission.status === "draft" && <button disabled={pending} onClick={() => run(() => adminSetMissionStatus(mission.id, "open"))}>Reopen to Scouts</button>}
            {mission.status === "open" && <button disabled={pending} onClick={() => run(() => adminSetMissionStatus(mission.id, "draft"))}>Pull from Scouts</button>}
            {!['completed', 'cancelled', 'disputed'].includes(mission.status) && !['authorized', 'paid', 'partially_refunded', 'refunded', 'disputed'].includes(mission.paymentStatus) && <button className="danger-link" disabled={pending} onClick={() => run(() => adminSetMissionStatus(mission.id, "cancelled"))}>Cancel</button>}
            {['completed', 'cancelled', 'draft'].includes(mission.status) && <button disabled={pending} onClick={() => run(() => adminArchiveMission(mission.id))}>Archive</button>}
          </div>
        </article>)}</div> : <div className="control-empty">No missions have been submitted.</div>}
      </section>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Mission cases</h2><p>Cancellation, no-show, safety and service reports with an auditable resolution.</p></div></div>
        {cases.length ? <div className="case-list">{cases.map((item) => <article key={item.id}>
          <div className="case-heading"><div><small>{titleCase(item.kind)} · {item.reporter}</small><strong>{item.missionTitle}</strong><span>Opened {new Date(item.createdAt).toLocaleString()} · mission was {titleCase(item.previousMissionStatus)}</span></div><span className={`status ${item.status === "resolved" ? "" : "warning-status"}`}>{titleCase(item.status)}</span></div>
          <p>{item.summary}</p>
          <Link href={`/dashboard/missions/${item.missionId}`}>Open mission <IconArrowRight size={15} /></Link>
          {item.status === "open" ? <CaseResolutionControls item={item} pending={pending} resolve={(resolution, notes, refund, payout) => run(() => adminResolveMissionCase(item.id, resolution, notes, refund, payout))} /> : <div className="case-resolution"><strong>Resolution: {titleCase(item.resolution ?? "resolved")}</strong><p>{item.adminNotes}</p><small>Refund authorized: {money(item.refundAmountCents)} · Scout payout authorized: {money(item.payoutAmountCents)}</small></div>}
        </article>)}</div> : <div className="control-empty">No mission cases have been submitted.</div>}
      </section>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Operational alerts</h2><p>Application exceptions and hourly marketplace health checks.</p></div></div>
        {operationalEvents.length ? <div className="control-table email-delivery-list">{operationalEvents.map((item) => <article key={item.id}>
          <div className="control-primary"><strong>{titleCase(item.category)}</strong><span>{item.message}</span><small>Last seen {new Date(item.lastSeenAt).toLocaleString()} · {item.occurrenceCount} occurrence{item.occurrenceCount === 1 ? "" : "s"}{item.alertedAt ? " · operations email sent" : ""}</small></div>
          <span className={`status ${item.severity === "critical" || item.severity === "error" ? "warning-status" : ""}`}>{titleCase(item.status)}</span>
          <div className="control-actions">{item.status === "open" && <button disabled={pending} onClick={() => run(() => adminSetOperationalEventStatus(item.id, "acknowledged"))}>Acknowledge</button>}{item.status !== "resolved" && <button disabled={pending} onClick={() => run(() => adminSetOperationalEventStatus(item.id, "resolved"))}><IconCheck size={15} /> Resolve</button>}</div>
        </article>)}</div> : <div className="control-empty">No operational exceptions or health alerts recorded.</div>}
      </section>

      <section className="control-section">
        <div className="control-section-title"><div><h2>Message delivery</h2><p>Recent email and text alerts, provider results and controlled retries. Sent SMS mode: <strong>{sentMode}</strong>.</p></div></div>
        {messageNotifications.length ? <div className="control-table email-delivery-list">{messageNotifications.map((item) => <article key={item.id}>
          <div className="control-primary"><small>{item.channel.toUpperCase()}</small><strong>{item.title}</strong><span>{item.recipient} · {new Date(item.createdAt).toLocaleString()}</span><small>{item.status === "failed" ? item.error || `Provider rejected the ${item.channel}` : item.sentAt ? `Delivered ${new Date(item.sentAt).toLocaleString()}` : "Awaiting provider result"} · {item.attempts} attempt{item.attempts === 1 ? "" : "s"}</small></div>
          <span className={`status ${item.status === "failed" ? "warning-status" : ""}`}>{titleCase(item.status)}</span>
          <div className="control-actions">{item.status !== "sent" && <button disabled={pending} onClick={() => run(() => adminRetryNotification(item.id))}><IconRefresh size={15} /> Retry</button>}</div>
        </article>)}</div> : <div className="control-empty">No email or text delivery records yet.</div>}
      </section>
    </div>
  </main>;
}

function CaseResolutionControls({ item, pending, resolve }: { item: CaseRow; pending: boolean; resolve: (resolution: "resume" | "cancel" | "complete" | "hold", notes: string, refund: number, payout: number) => void }) {
  const proposedResolution = (["resume", "cancel", "complete", "hold"] as const).find((value) => value === item.resolution) ?? "hold";
  const [resolution, setResolution] = useState<"resume" | "cancel" | "complete" | "hold">(item.financialApprovalPending ? proposedResolution : "hold");
  const [notes, setNotes] = useState("");
  const [refundInput, setRefundInput] = useState(item.financialApprovalPending ? (item.refundAmountCents / 100).toFixed(2) : "0.00");
  const [payoutInput, setPayoutInput] = useState(item.financialApprovalPending ? (item.payoutAmountCents / 100).toFixed(2) : "0.00");
  const [validationError, setValidationError] = useState("");
  const lockedFinancialProposal = item.financialApprovalPending && !item.proposedByCurrentAdmin;
  function submit() {
    const refund = centsFromInput(refundInput);
    const payout = centsFromInput(payoutInput);
    if (notes.trim().length < 5) return setValidationError("Add a brief internal resolution note before resolving the case.");
    if (refund === null || refund > item.customerPriceCents) return setValidationError(`Enter a refund between $0 and ${(item.customerPriceCents / 100).toFixed(2)}.`);
    if (payout === null || payout > item.scoutPayoutCents) return setValidationError(`Enter a Scout payout between $0 and ${(item.scoutPayoutCents / 100).toFixed(2)}.`);
    if (resolution === "hold" && (refund !== 0 || payout !== 0)) return setValidationError("Keep-paused reviews cannot record money until a final outcome is selected.");
    setValidationError("");
    resolve(resolution, notes.trim(), refund, payout);
  }
  const zeroAdjustments = centsFromInput(refundInput) === 0 && centsFromInput(payoutInput) === 0;
  return <div className="case-controls">{item.adminNotes && <div className="case-resolution"><strong>Saved review notes</strong><p>{item.adminNotes}</p></div>}{item.financialApprovalPending && <p className="form-note">This refund is over $100. {item.proposedByCurrentAdmin ? "A different administrator must approve the unchanged proposal; you may revise it here." : "Review the evidence, then approve the locked proposal below or ask its proposer to revise it."}</p>}<label><span>Outcome</span><select disabled={lockedFinancialProposal} value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}><option value="hold">Keep paused</option><option value="resume">Resume mission</option><option value="cancel">Cancel mission</option><option value="complete">Mark complete</option></select></label><label><span>Refund · remaining maximum {money(item.customerPriceCents)}</span><input disabled={lockedFinancialProposal} inputMode="decimal" type="number" min="0" max={item.customerPriceCents / 100} step="1" value={refundInput} onChange={(event) => setRefundInput(event.target.value)} onBlur={() => setRefundInput(normalizeMoneyInput(refundInput))} /></label><label><span>Scout payout · remaining maximum {money(item.scoutPayoutCents)}</span><input disabled={lockedFinancialProposal} inputMode="decimal" type="number" min="0" max={item.scoutPayoutCents / 100} step="1" value={payoutInput} onChange={(event) => setPayoutInput(event.target.value)} onBlur={() => setPayoutInput(normalizeMoneyInput(payoutInput))} /></label><label className="case-notes"><span>Internal review note · required</span><textarea rows={3} maxLength={3000} placeholder="Briefly explain the decision and evidence reviewed." value={notes} onChange={(event) => setNotes(event.target.value)} /></label>{validationError && <p className="case-validation-error" role="alert">{validationError}</p>}<button disabled={pending} onClick={submit}>{pending ? resolution === "hold" ? "Saving…" : "Resolving…" : lockedFinancialProposal ? "Approve & resolve case" : item.financialApprovalPending ? "Revise proposal" : resolution === "hold" ? "Save & keep paused" : "Resolve case"}</button><small>{item.financialApprovalPending ? "The second approval must preserve the proposed outcome and both amounts. " : resolution === "hold" ? "Keeping a case paused saves the review note but does not close the case or authorize money. " : resolution === "complete" && zeroAdjustments ? "Marking complete with both amounts at $0 releases the normal full Scout payout. " : "Refund capacity is durably reserved before the case closes and provider processing remains recoverable if delayed. "}Use the amount in dollars; keyboard entry is supported.</small></div>;
}

function centsFromInput(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}
function normalizeMoneyInput(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount.toFixed(2) : "0.00";
}

function ControlStat({ icon: Icon, label, value, href, alert = false }: { icon: typeof IconUsers; label: string; value: number; href?: string; alert?: boolean }) {
  const content = <><Icon size={23} /><div><small>{label}</small><strong>{value}</strong></div>{alert && <span className="control-new-badge">New</span>}</>;
  return href ? <Link className={alert ? "control-stat-alert" : ""} href={href}>{content}</Link> : <article className={alert ? "control-stat-alert" : ""}>{content}</article>;
}
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100); }
