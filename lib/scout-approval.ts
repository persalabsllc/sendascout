import { hasCurrentScoutHandbookAcceptance } from "./scout-handbook.ts";

export type ScoutApprovalInput = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  legalVersion: string | null;
  handbookVersion: string | null;
  handbookAcceptedAt: Date | null;
  identityCheck: string;
  identityVerifiedName: string | null;
  identityVerifiedAt: Date | null;
  headshotPath: string | null;
  homeZip: string | null;
  vehicleType: string | null;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
  verificationConsentedAt: Date | null;
  stripeAccountId: string | null;
  stripeAccountLivemode: boolean | null;
  stripeConnectStatus: string;
  stripeDetailsSubmitted?: boolean;
  stripeTransfersActive: boolean;
  payoutsEnabled: boolean;
  stripeRequirementsCurrentlyDue?: string[];
  stripeRequirementsPastDue?: string[];
  stripeRequirementsPendingVerification?: string[];
  stripePayoutScheduleConfiguredAt: Date | null;
};

export type ScoutApprovalCheck = { key: string; label: string; complete: boolean };
export type ScoutStripeReadinessState = "complete" | "pending" | "action_required" | "missing";
export type ScoutStripeReadinessCheck = {
  key: string;
  label: string;
  state: ScoutStripeReadinessState;
  detail?: string;
};
export type ScoutOnboardingNextStep = {
  key: string;
  label: string;
  owner: "scout" | "control_room" | "stripe" | "system" | "complete";
  actionHref?: string;
  actionLabel?: string;
};

export function scoutApprovalChecklist(input: ScoutApprovalInput, currentLegalVersion: string, expectedLivemode: boolean): ScoutApprovalCheck[] {
  return [
    { key: "identity", label: "Government ID and verified legal name recorded", complete: input.identityCheck === "clear" && Boolean(input.identityVerifiedName?.trim() && input.identityVerifiedAt) },
    { key: "terms", label: "Current marketplace terms accepted", complete: input.legalVersion === currentLegalVersion },
    { key: "handbook", label: "Current Scout Handbook acknowledged", complete: hasCurrentScoutHandbookAcceptance(input) },
    { key: "name", label: "First and last legal name provided", complete: Boolean(input.firstName?.trim() && input.lastName?.trim()) },
    { key: "phone", label: "Mobile number provided", complete: (input.phone?.replace(/\D/g, "").length ?? 0) >= 10 },
    { key: "headshot", label: "Current profile headshot uploaded", complete: Boolean(input.headshotPath) },
    { key: "zone", label: "Valid service ZIP and travel zone selected", complete: /^\d{5}$/.test(input.homeZip?.trim() ?? "") },
    { key: "vehicle", label: "Vehicle access recorded", complete: Boolean(input.vehicleType?.trim()) },
    { key: "missions", label: "At least one mission type selected", complete: input.canSee || input.canMove || input.canMeet },
    { key: "consent", label: "Verification consent recorded", complete: Boolean(input.verificationConsentedAt) },
    { key: "payouts", label: "Stripe payout account verified and ready", complete: Boolean(input.stripeAccountId && input.stripeAccountLivemode === expectedLivemode && input.stripeConnectStatus === "ready" && input.stripeTransfersActive && input.payoutsEnabled && input.stripePayoutScheduleConfiguredAt) },
  ];
}

export function scoutReadyForApproval(input: ScoutApprovalInput, currentLegalVersion: string, expectedLivemode: boolean) {
  return scoutApprovalChecklist(input, currentLegalVersion, expectedLivemode).every((item) => item.complete);
}

export function scoutStripeReadinessChecklist(input: ScoutApprovalInput, expectedLivemode: boolean): ScoutStripeReadinessCheck[] {
  const hasAccount = Boolean(input.stripeAccountId);
  const modeMatches = hasAccount && input.stripeAccountLivemode === expectedLivemode;
  const due = [...(input.stripeRequirementsPastDue ?? []), ...(input.stripeRequirementsCurrentlyDue ?? [])];
  const restricted = input.stripeConnectStatus === "restricted" || input.stripeConnectStatus === "disabled" || due.length > 0;
  const verificationState: ScoutStripeReadinessState = input.stripeConnectStatus === "ready"
    ? "complete"
    : restricted
      ? "action_required"
      : hasAccount
        ? "pending"
        : "missing";
  const capabilitiesReady = input.stripeTransfersActive && input.payoutsEnabled;

  return [
    {
      key: "account",
      label: "Connected Stripe account created",
      state: hasAccount ? "complete" : "missing",
    },
    {
      key: "mode",
      label: "Stripe environment confirmed",
      state: modeMatches ? "complete" : hasAccount ? "action_required" : "missing",
      detail: hasAccount && !modeMatches ? "The connected account does not match the live payment environment." : undefined,
    },
    {
      key: "details",
      label: "Stripe payout information submitted",
      state: input.stripeDetailsSubmitted ? "complete" : hasAccount ? (restricted ? "action_required" : "pending") : "missing",
    },
    {
      key: "verification",
      label: "Stripe verification cleared",
      state: verificationState,
      detail: input.stripeRequirementsPendingVerification?.length ? "Stripe is reviewing submitted information." : undefined,
    },
    {
      key: "capabilities",
      label: "Transfers and bank payouts enabled",
      state: capabilitiesReady ? "complete" : restricted ? "action_required" : hasAccount ? "pending" : "missing",
    },
    {
      key: "schedule",
      label: "Automatic weekly Friday payout schedule verified",
      state: input.stripePayoutScheduleConfiguredAt ? "complete" : capabilitiesReady ? "pending" : hasAccount ? "pending" : "missing",
      detail: "Configured automatically by Send a Scout; no Scout action is required.",
    },
  ];
}

export function nextScoutOnboardingStep(
  input: ScoutApprovalInput,
  currentLegalVersion: string,
  expectedLivemode: boolean,
  profileStatus: string,
): ScoutOnboardingNextStep {
  if (profileStatus === "rejected") return { key: "rejected", label: "Application rejected — review before taking further action.", owner: "control_room" };
  if (profileStatus === "paused") return { key: "paused", label: "Scout access is paused.", owner: "control_room" };
  const missing = new Set(scoutApprovalChecklist(input, currentLegalVersion, expectedLivemode)
    .filter((item) => !item.complete)
    .map((item) => item.key));
  const profileKeys = ["name", "phone", "headshot", "zone", "vehicle", "missions", "consent"];
  const missingProfile = profileKeys.filter((key) => missing.has(key));
  const profileLabels: Record<string, string> = {
    name: "legal name",
    phone: "mobile number",
    headshot: "profile headshot",
    zone: "service ZIP and travel zone",
    vehicle: "vehicle access",
    missions: "mission preferences",
    consent: "verification consent",
  };

  if (missingProfile.length) {
    return {
      key: "profile",
      label: `Scout must complete profile requirements: ${missingProfile.map((key) => profileLabels[key]).join(", ")}.`,
      owner: "scout",
      actionHref: "/dashboard/scout/settings",
      actionLabel: "Open profile",
    };
  }
  if (missing.has("terms")) {
    return {
      key: "terms",
      label: "Scout must accept the current marketplace terms.",
      owner: "scout",
      actionHref: "/legal/accept",
      actionLabel: "Review terms",
    };
  }
  if (missing.has("handbook")) {
    return {
      key: "handbook",
      label: "Scout must review and acknowledge the current Scout Handbook.",
      owner: "scout",
      actionHref: "/dashboard/scout/handbook",
      actionLabel: "Review handbook",
    };
  }
  if (missing.has("payouts")) {
    if (!input.stripeAccountId) {
      return {
        key: "payouts",
        label: "Scout must start Stripe payout setup.",
        owner: "scout",
        actionHref: "/dashboard/scout/earnings",
        actionLabel: "Set up payouts",
      };
    }
    if (input.stripeAccountLivemode !== expectedLivemode) {
      return { key: "payouts", label: "Control Room must reconnect this profile to the live Stripe environment.", owner: "control_room" };
    }
    if (input.stripeConnectStatus === "restricted" || input.stripeConnectStatus === "disabled") {
      return {
        key: "payouts",
        label: "Scout must finish the information Stripe is requesting.",
        owner: "scout",
        actionHref: "/dashboard/scout/earnings",
        actionLabel: "Update Stripe",
      };
    }
    if (input.stripeConnectStatus === "pending" || (input.stripeRequirementsPendingVerification?.length ?? 0) > 0) {
      return { key: "payouts", label: "Stripe is reviewing the submitted payout information.", owner: "stripe" };
    }
    if (!input.stripeDetailsSubmitted || input.stripeConnectStatus === "onboarding" || input.stripeConnectStatus === "not_started") {
      return {
        key: "payouts",
        label: "Scout must finish Stripe payout setup.",
        owner: "scout",
        actionHref: "/dashboard/scout/earnings",
        actionLabel: "Continue Stripe",
      };
    }
    if (!input.stripeTransfersActive || !input.payoutsEnabled) {
      return { key: "payouts", label: "Waiting for Stripe to enable transfers and bank payouts.", owner: "stripe" };
    }
    return { key: "payouts", label: "Send a Scout is verifying the automatic weekly payout schedule.", owner: "system" };
  }
  if (missing.has("identity")) {
    return { key: "identity", label: "Control Room must complete the live government ID review.", owner: "control_room" };
  }
  if (profileStatus !== "approved") return { key: "approval", label: "All requirements complete — Control Room can approve this Scout.", owner: "control_room" };
  return { key: "complete", label: "Onboarding complete — ready to claim missions.", owner: "complete" };
}
