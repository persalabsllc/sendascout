"use client";

import { useState, useTransition } from "react";
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
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const modeMismatch = props.hasAccount && !props.livemodeMatches;
  const ready = props.status === "ready" && props.livemodeMatches && props.canReceiveTransfers && props.payoutScheduleConfigured;
  const due = [...props.pastDue, ...props.currentlyDue];
  const needsAction = modeMismatch || due.length > 0 || props.status === "restricted" || props.status === "onboarding" || props.status === "not_started";

  function openOnboarding() {
    setMessage("");
    startTransition(async () => {
      const result = await startScoutStripeOnboarding();
      if (!result.ok) setMessage(result.error);
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
      </> : props.status === "pending" ? <>
        <p>Stripe is reviewing the information you submitted. You can refresh this page or reopen setup if Stripe requests anything else.</p>
        {props.pendingVerification.length > 0 && <p className="payout-account-note">{props.pendingVerification.length} item{props.pendingVerification.length === 1 ? " is" : "s are"} pending verification.</p>}
      </> : <>
        <p>{modeMismatch ? "This payout account does not match the current Stripe payment environment. Contact Control Room to reconnect it before claiming new missions." : props.hasAccount ? "Finish the secure Stripe form so Send a Scout can transfer your mission earnings." : "Create your free Stripe payout account and add the bank account or eligible debit card that should receive your earnings."}</p>
        {due.length > 0 && <ul>{due.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>}
        {props.disabledReason && <p className="payout-account-note">Stripe status: {props.disabledReason.replaceAll("_", " ")}</p>}
      </>}
      {message && <p className={message.includes("refreshed") ? "form-success" : "form-error"}>{message}</p>}
      <div className="payout-account-actions">
        {ready && !needsAction ? <button className="button" disabled={pending} onClick={openDashboard}>Manage payouts in Stripe <IconExternalLink size={17} /></button> : <button className="button" disabled={pending} onClick={openOnboarding}>{props.hasAccount ? "Update payout setup" : "Set up secure payouts"} <IconExternalLink size={17} /></button>}
        <button className="button button-ghost" disabled={pending} onClick={refresh}><IconRefresh size={17} /> Refresh status</button>
      </div>
    </div>
  </section>;
}
