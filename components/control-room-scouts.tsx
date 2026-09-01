"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconCheck, IconClock, IconRefresh, IconX } from "@tabler/icons-react";
import { adminSetScoutStatus } from "@/app/actions/missions";
import { adminRefreshScoutStripeStatus } from "@/app/actions/stripe-connect";
import { Brand } from "./brand";

export type ApprovalCheck = { key: string; label: string; complete: boolean };
type StripeReadinessCheck = { key: string; label: string; state: "complete" | "pending" | "action_required" | "missing"; detail?: string };
type OnboardingNextStep = { key: string; label: string; owner: "scout" | "control_room" | "stripe" | "system" | "complete"; actionHref?: string; actionLabel?: string };
type StripeReadiness = {
  hasAccount: boolean;
  statusLabel: string;
  syncedAt: string | null;
  checks: StripeReadinessCheck[];
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  futureDue: string[];
  disabledReason: string | null;
};
export type ScoutAdminRow = { id: string; name: string; email: string; phone: string; zip: string; vehicle: string; radius: number; status: string; capabilities: string; identityStatus: string; identityProvider: string | null; identityVerifiedAt: string | null; legalVersion: string | null; legalAcceptedAt: string | null; checklist: ApprovalCheck[]; nextStep: OnboardingNextStep; stripe: StripeReadiness };

export function ControlRoomScouts({ scouts }: { scouts: ScoutAdminRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, successMessage?: string) {
    setError("");
    setFeedback("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else {
        if (successMessage) setFeedback(successMessage);
        router.refresh();
      }
    });
  }
  return <main className="control-page">
    <header className="control-header"><Brand href="/control-room" /><div><span>Private operations</span><Link href="/control-room">Control Room</Link><Link href="/">Public site</Link></div></header>
    <div className="control-shell">
      <Link className="control-back" href="/control-room"><IconArrowLeft size={16} /> Marketplace operations</Link>
      <div className="control-title"><div><span className="kicker">Scout management</span><h1>Scouts and applications</h1><p>Monitor automated onboarding, Stripe requirements and Scout account status without crowding the main operations dashboard.</p></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {feedback && <p className="form-success" role="status">{feedback}</p>}
      <section className="control-section">
        <div className="control-section-title"><div><h2>All Scouts</h2><p>{scouts.length} Scout account{scouts.length === 1 ? "" : "s"} · newest applications first</p></div></div>
        {scouts.length ? <div className="control-table">{scouts.map((scout) => <article key={scout.id}>
          <div className="control-primary">
            <strong>{scout.name}</strong><span>{scout.email} · {scout.phone || "No phone"}</span>
            <small>{scout.vehicle || "Vehicle not provided"} · {scout.zip} + {scout.radius} miles · {scout.capabilities}</small>
            <small>{stripeIdentityIsClear(scout) ? `Stripe identity cleared${scout.identityVerifiedAt ? ` ${formatUtcDate(scout.identityVerifiedAt)}` : ""}` : "Stripe identity not yet cleared"} · {scout.legalVersion ? `Terms ${scout.legalVersion} accepted` : "Terms acceptance pending"}</small>
            <div className={`scout-next-step owner-${scout.nextStep.owner}`}><strong>Recommended next action</strong><span>{scout.nextStep.label}</span></div>
            <div className="approval-checklist">{scout.checklist.filter((item) => item.key !== "payouts").map((item) => <span className={item.complete ? "complete" : "missing"} key={item.key}>{item.complete ? <IconCheck size={13} /> : <IconX size={13} />}{item.label}</span>)}</div>
            <StripeReadinessDetails stripe={scout.stripe} />
          </div>
          <span className="status">{titleCase(scout.status)}</span>
          <div className="control-actions">
            {scout.stripe.hasAccount && <button disabled={pending} onClick={() => run(() => adminRefreshScoutStripeStatus(scout.id), `Stripe status refreshed for ${scout.name}.`)}><IconRefresh size={16} /> Refresh Stripe</button>}
            {(scout.status === "applicant" || scout.status === "review") && <span className="control-automatic-status"><IconClock size={16} /> Approves automatically when ready</span>}
            {scout.status === "paused" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "approved"))}><IconCheck size={16} /> Restore access</button>}
            {scout.status === "approved" && <button disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "paused"))}>Pause</button>}
            {scout.status !== "rejected" && <button className="danger-link" disabled={pending} onClick={() => run(() => adminSetScoutStatus(scout.id, "rejected"))}><IconX size={16} /> Reject</button>}
          </div>
        </article>)}</div> : <div className="control-empty">No Scout applications yet.</div>}
        <p className="control-review-note">Stripe verifies the legal identity used for payouts and Send a Scout records only the verified name, Stripe reference and verification time. Control Room does not review or store identity documents. Stripe may clear identity without requesting a photo ID; mandatory photo-ID or selfie checks would require a separate identity-verification service.</p>
      </section>
    </div>
  </main>;
}

function StripeReadinessDetails({ stripe }: { stripe: StripeReadiness }) {
  const actionRequired = [...new Set([...stripe.pastDue, ...stripe.currentlyDue])];
  const overallState = stripe.checks.every((check) => check.state === "complete")
    ? "complete"
    : stripe.checks.some((check) => check.state === "action_required")
      ? "action-required"
      : stripe.checks.some((check) => check.state === "pending")
        ? "pending"
        : "missing";
  const overallLabel = overallState === "complete" ? "Payout setup ready" : overallState === "action-required" ? "Action required" : overallState === "pending" ? "Setup in progress" : "Not started";
  return <details className="stripe-readiness">
    <summary><span><strong>Stripe payout readiness</strong><small>Stripe account: {stripe.statusLabel} · {stripe.syncedAt ? `synced ${formatUtcDateTime(stripe.syncedAt)} UTC` : "not synced yet"}</small></span><span className={`stripe-status stripe-status-${overallState}`}>{overallLabel}</span></summary>
    <div className="stripe-readiness-grid">
      {stripe.checks.map((check) => <div className={`stripe-readiness-row ${check.state.replace("_", "-")}`} key={check.key}>
        <span>{check.state === "complete" ? <IconCheck size={14} /> : check.state === "pending" ? <IconClock size={14} /> : <IconX size={14} />}</span>
        <div><strong>{check.label}</strong>{check.detail && <small>{check.detail}</small>}</div>
      </div>)}
    </div>
    {stripe.disabledReason && <p className="stripe-requirement action-required"><strong>Stripe status:</strong> {stripe.disabledReason.replaceAll("_", " ")}</p>}
    {actionRequired.length > 0 && <RequirementList title="Scout action required" tone="action-required" items={actionRequired} />}
    {stripe.pendingVerification.length > 0 && <RequirementList title="Stripe is reviewing" tone="pending" items={stripe.pendingVerification} />}
    {stripe.futureDue.length > 0 && <RequirementList title="Future Stripe requirements" tone="future" items={stripe.futureDue} />}
  </details>;
}

function RequirementList({ title, tone, items }: { title: string; tone: string; items: string[] }) {
  return <div className={`stripe-requirement ${tone}`}><strong>{title}</strong><ul>{[...new Set(items)].map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function formatUtcDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(value));
}

function formatUtcDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}

function stripeIdentityIsClear(scout: ScoutAdminRow) {
  return scout.checklist.find((item) => item.key === "identity")?.complete === true;
}

function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
