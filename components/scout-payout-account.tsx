"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconAlertTriangle, IconExternalLink, IconRefresh, IconShieldCheck, IconWallet } from "@tabler/icons-react";
import { openScoutStripeDashboard, refreshScoutStripeStatus, startScoutStripeOnboarding } from "@/app/actions/stripe-connect";
import { stripeConnectStatusLabel } from "@/lib/stripe-connect";

type Props = {
  status: string;
  hasAccount: boolean;
  livemodeMatches: boolean;
  canReceiveTransfers: boolean;
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  futureDue: string[];
  disabledReason: string | null;
  payoutScheduleConfigured: boolean;
};

export function ScoutPayoutAccount(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [showAccountChoice, setShowAccountChoice] = useState(false);
  const choiceHeadingRef = useRef<HTMLHeadingElement>(null);
  const modeMismatch = props.hasAccount && !props.livemodeMatches;
  const ready = props.status === "ready" && props.livemodeMatches && props.canReceiveTransfers && props.payoutScheduleConfigured;
  const schedulePending = props.status === "ready" && props.livemodeMatches && props.canReceiveTransfers && !props.payoutScheduleConfigured;
  const due = [...new Set([...props.pastDue, ...props.currentlyDue])];
  const needsAction = modeMismatch || due.length > 0 || props.status === "restricted" || props.status === "onboarding" || props.status === "not_started";

  useEffect(() => {
    if (showAccountChoice) choiceHeadingRef.current?.focus();
  }, [showAccountChoice]);

  function openOnboarding(payoutOwnerType?: "individual" | "company") {
    if (!props.hasAccount && !payoutOwnerType) {
      setShowAccountChoice(true);
      setMessage("");
      return;
    }
    setMessage("");
    startTransition(async () => {
      const result = await startScoutStripeOnboarding(payoutOwnerType);
      if (!result.ok) {
        setMessage(result.error);
        router.refresh();
      }
      else window.location.assign(result.url);
    });
  }

  function openDashboard() {
    setMessage("");
    startTransition(async () => {
      const result = await openScoutStripeDashboard();
      if (!result.ok) setMessage(result.error);
      else window.location.assign(result.url);
    });
  }

  function refresh() {
    setMessage("");
    startTransition(async () => {
      const result = await refreshScoutStripeStatus();
      setMessage(result.ok ? "Stripe payout status refreshed." : result.error);
    });
  }

  return <section className={`payout-account-card ${ready ? "ready" : needsAction ? "needs-action" : "pending"}`}>
    <span className="payout-account-icon">{ready ? <IconShieldCheck size={30} /> : needsAction ? <IconAlertTriangle size={30} /> : <IconWallet size={30} />}</span>
    <div className="payout-account-main">
      <div className="payout-account-heading"><div><span className="kicker">Stripe Connect</span><h2>Scout payout account</h2></div><span className="status">{modeMismatch ? "Reconnect required" : stripeConnectStatusLabel(props.status)}</span></div>
      {ready ? <>
        <p>Your account can receive mission earnings. Send a Scout initiates eligible transfers each Friday UTC; bank arrival follows Stripe&apos;s payout timing.</p>
        {due.length > 0 && <><p className="payout-account-note">Stripe needs updated information. Transfers are currently available, but complete these items before they become past due.</p><ul>{due.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul></>}
        {!due.length && props.futureDue.length > 0 && <p className="payout-account-note">Stripe lists {props.futureDue.length} future requirement{props.futureDue.length === 1 ? "" : "s"}. We’ll keep showing them here before they become due.</p>}
      </> : schedulePending ? <>
        <p>Your Stripe account can receive earnings. Send a Scout is confirming the automatic weekly Friday payout schedule. No action is required from you while this finishes.</p>
      </> : props.status === "pending" ? <>
        <p>Stripe is reviewing the information you submitted. You can refresh this page or reopen setup if Stripe requests anything else.</p>
        {props.pendingVerification.length > 0 && <p className="payout-account-note">{props.pendingVerification.length} item{props.pendingVerification.length === 1 ? " is" : "s are"} pending verification.</p>}
      </> : <>
        <p>{modeMismatch ? "This payout account does not match the current Stripe payment environment. Contact Control Room to reconnect it before claiming new missions." : props.hasAccount ? "Finish the secure Stripe form so Send a Scout can transfer your mission earnings." : "Create your free Stripe payout account and add the bank account or eligible debit card that should receive your earnings. Stripe verifies everyone who receives payouts, but you do not need an LLC or business website to Scout."}</p>
        {due.length > 0 && <ul>{due.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>}
        {props.disabledReason && <p className="payout-account-note">Stripe status: {props.disabledReason.replaceAll("_", " ")}</p>}
      </>}
      {showAccountChoice && !props.hasAccount && <div className="payout-account-choice" role="group" aria-busy={pending} aria-labelledby="payout-owner-question">
        <h3 id="payout-owner-question" ref={choiceHeadingRef} tabIndex={-1}>How should Stripe verify you?</h3>
        <p>Stripe uses business language for every payout account. Choose the name that should legally receive your mission earnings.</p>
        <div className="payout-account-choice-grid">
          <button type="button" disabled={pending} onClick={() => openOnboarding("individual")}>
            <strong>As myself <span>Most Scouts</span></strong>
            <small>Use your own legal name. No LLC or business website is needed.</small>
          </button>
          <button type="button" disabled={pending} onClick={() => openOnboarding("company")}>
            <strong>Through my registered business</strong>
            <small>Only choose this if an LLC, partnership, or corporation should receive payouts.</small>
          </button>
        </div>
        {pending && <p className="payout-account-opening" role="status">Opening secure Stripe setup…</p>}
        <button type="button" className="payout-account-choice-cancel" disabled={pending} onClick={() => setShowAccountChoice(false)}>Not now</button>
      </div>}
      {message && <p className={message.includes("refreshed") ? "form-success" : "form-error"}>{message}</p>}
      <div className="payout-account-actions">
        {ready && !needsAction ? <button className="button" disabled={pending} onClick={openDashboard}>Manage payouts in Stripe <IconExternalLink size={17} /></button> : !schedulePending && !showAccountChoice && <button className="button" disabled={pending} onClick={() => openOnboarding()}>{pending ? "Opening Stripe…" : props.hasAccount ? "Update payout setup" : "Set up secure payouts"} {!pending && <IconExternalLink size={17} />}</button>}
        <button className="button button-ghost" disabled={pending} onClick={refresh}><IconRefresh size={17} /> Refresh status</button>
      </div>
    </div>
  </section>;
}
