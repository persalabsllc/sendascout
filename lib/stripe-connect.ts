export type StripeConnectStatus = "not_started" | "onboarding" | "pending" | "ready" | "restricted" | "disabled";

export type StripeConnectSummary = {
  status: StripeConnectStatus;
  detailsSubmitted: boolean;
  transfersActive: boolean;
  payoutsEnabled: boolean;
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  futureDue: string[];
  disabledReason: string | null;
  livemode: boolean;
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? value as UnknownRecord : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function capabilityStatus(value: unknown) {
  const capability = record(value);
  return typeof capability.status === "string" ? capability.status : null;
}

function capabilityReason(value: unknown) {
  const capability = record(value);
  const details = Array.isArray(capability.status_details) ? capability.status_details : [];
  const first = record(details[0]);
  return typeof first.code === "string" ? first.code : null;
}

export function summarizeV2ConnectAccount(accountValue: unknown): StripeConnectSummary {
  const account = record(accountValue);
  const configuration = record(account.configuration);
  const recipient = record(configuration.recipient);
  const capabilities = record(recipient.capabilities);
  const balance = record(capabilities.stripe_balance);
  const transfers = balance.stripe_transfers;
  const payouts = balance.payouts;
  const transfersStatus = capabilityStatus(transfers);
  const payoutsStatus = capabilityStatus(payouts);
  const entries = Array.isArray(record(account.requirements).entries) ? record(account.requirements).entries as unknown[] : [];
  const currentlyDue: string[] = [];
  const pastDue: string[] = [];
  const pendingVerification: string[] = [];
  const futureDue: string[] = [];

  for (const entryValue of entries) {
    const entry = record(entryValue);
    const deadline = record(entry.minimum_deadline);
    const description = typeof entry.description === "string" ? entry.description : "Stripe account information";
    const awaiting = typeof entry.awaiting_action_from === "string" ? entry.awaiting_action_from : "user";
    if (awaiting === "stripe") pendingVerification.push(description);
    else if (deadline.status === "past_due") pastDue.push(description);
    else if (deadline.status === "currently_due") currentlyDue.push(description);
  }
  const futureEntries = Array.isArray(record(account.future_requirements).entries) ? record(account.future_requirements).entries as unknown[] : [];
  for (const entryValue of futureEntries) {
    const entry = record(entryValue);
    const description = typeof entry.description === "string" ? entry.description : "Stripe account information";
    futureDue.push(description);
  }

  const applied = stringArray(account.applied_configurations).includes("recipient");
  const transfersActive = transfersStatus === "active";
  const payoutsEnabled = payoutsStatus === "active";
  const detailsSubmitted = applied && currentlyDue.length === 0 && pastDue.length === 0;
  const disabledReason = capabilityReason(transfers) ?? capabilityReason(payouts);
  const status: StripeConnectStatus = account.closed === true
    ? "disabled"
    : pastDue.length > 0 || currentlyDue.length > 0 || transfersStatus === "restricted" || payoutsStatus === "restricted"
        ? "restricted"
      : pendingVerification.length > 0 || transfersStatus === "pending" || payoutsStatus === "pending"
          ? "pending"
        : transfersActive && payoutsEnabled
          ? "ready"
          : applied
            ? "onboarding"
            : "not_started";

  return {
    status,
    detailsSubmitted,
    transfersActive,
    payoutsEnabled,
    currentlyDue: unique(currentlyDue),
    pastDue: unique(pastDue),
    pendingVerification: unique(pendingVerification),
    futureDue: unique(futureDue),
    disabledReason,
    livemode: account.livemode === true,
  };
}

export function summarizeV1ConnectAccount(accountValue: unknown): StripeConnectSummary {
  const account = record(accountValue);
  const capabilities = record(account.capabilities);
  const requirements = record(account.requirements);
  const currentlyDue = stringArray(requirements.currently_due);
  const pastDue = stringArray(requirements.past_due);
  const pendingVerification = stringArray(requirements.pending_verification);
  const futureRequirements = record(account.future_requirements);
  const futureDue = unique([
    ...stringArray(futureRequirements.currently_due),
    ...stringArray(futureRequirements.eventually_due),
  ]);
  const detailsSubmitted = account.details_submitted === true;
  const transfersActive = capabilities.transfers === "active";
  const payoutsEnabled = account.payouts_enabled === true;
  const disabledReason = typeof requirements.disabled_reason === "string" ? requirements.disabled_reason : null;
  const status: StripeConnectStatus = account.deleted === true
    ? "disabled"
    : disabledReason
    ? "restricted"
    : pastDue.length > 0 || currentlyDue.length > 0 || capabilities.transfers === "inactive"
        ? "restricted"
      : pendingVerification.length > 0 || capabilities.transfers === "pending"
          ? "pending"
        : transfersActive && payoutsEnabled
          ? "ready"
          : detailsSubmitted
            ? "pending"
            : "onboarding";

  return {
    status,
    detailsSubmitted,
    transfersActive,
    payoutsEnabled,
    currentlyDue,
    pastDue,
    pendingVerification,
    futureDue,
    disabledReason,
    livemode: account.livemode === true,
  };
}

export function scoutConnectReady(profile: {
  stripeAccountId?: string | null;
  stripeAccountLivemode?: boolean | null;
  stripeConnectStatus?: string | null;
  stripeTransfersActive?: boolean | null;
  payoutsEnabled?: boolean | null;
  stripePayoutScheduleConfiguredAt?: Date | null;
}, expectedLivemode: boolean) {
  return Boolean(
    profile.stripeAccountId
    && profile.stripeAccountLivemode === expectedLivemode
    && profile.stripeConnectStatus === "ready"
    && profile.stripeTransfersActive
    && profile.payoutsEnabled
    && profile.stripePayoutScheduleConfiguredAt,
  );
}

export function stripeConnectStatusLabel(status: string) {
  if (status === "ready") return "Ready";
  if (status === "restricted") return "Action required";
  if (status === "pending") return "Stripe reviewing";
  if (status === "onboarding") return "Setup incomplete";
  if (status === "disabled") return "Disabled";
  return "Not started";
}
