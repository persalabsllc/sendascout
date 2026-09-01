import "server-only";

import { createHash } from "node:crypto";

type StripeConnectTelemetryEvent =
  | "start_blocked_embedded_browser"
  | "start_failed"
  | "link_created"
  | "status_synced"
  | "return_synced"
  | "return_failed";

type StripeConnectTelemetryDetails = {
  userId?: string | null;
  accountId?: string | null;
  apiVersion?: "v1" | "v2" | null;
  source?: "start" | "refresh" | "sync" | "return";
  flow?: "onboarding" | "update";
  status?: string | null;
  ready?: boolean;
  detailsSubmitted?: boolean;
  transfersActive?: boolean;
  payoutsEnabled?: boolean;
  payoutScheduleConfigured?: boolean;
  currentlyDueCount?: number;
  pastDueCount?: number;
  pendingVerificationCount?: number;
  futureDueCount?: number;
};

/** A stable, non-reversible reference lets production logs correlate a funnel without exposing IDs. */
export function stripeConnectTelemetryRef(value: string | null | undefined) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : undefined;
}

export function buildStripeConnectTelemetry(event: StripeConnectTelemetryEvent, details: StripeConnectTelemetryDetails = {}) {
  const { userId, accountId, ...safeDetails } = details;
  return {
    level: "info",
    message: "Scout Stripe Connect funnel",
    event,
    scoutRef: stripeConnectTelemetryRef(userId),
    accountRef: stripeConnectTelemetryRef(accountId),
    ...safeDetails,
  };
}

export function logStripeConnectTelemetry(event: StripeConnectTelemetryEvent, details: StripeConnectTelemetryDetails = {}) {
  console.info(JSON.stringify(buildStripeConnectTelemetry(event, details)));
}
