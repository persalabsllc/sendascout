import { LEGAL_VERSION } from "./legal.ts";
import { SCOUT_HANDBOOK_VERSION } from "./scout-handbook.ts";

export const SCOUT_SUPPORT_EMAIL = "support@sendascout.com";

export type ScoutOnboardingProgressInput = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  legalVersion: string | null;
  legalAcceptedAt: Date | null;
  handbookVersion: string | null;
  handbookAcceptedAt: Date | null;
  headshotPath: string | null;
  homeZip: string | null;
  serviceRadiusMiles: number;
  vehicleType: string | null;
  canSee: boolean;
  canMove: boolean;
  canMeet: boolean;
  verificationConsentedAt: Date | null;
  identityCheck: string;
  identityProvider: string | null;
  identityVerificationReference: string | null;
  identityVerifiedName: string | null;
  identityVerifiedAt: Date | null;
  identityVerifiedBy: string | null;
  stripeAccountId: string | null;
  stripeAccountApiVersion: string | null;
  stripeAccountLivemode: boolean | null;
  stripeConnectStatus: string;
  stripeDetailsSubmitted: boolean;
  stripeTransfersActive: boolean;
  payoutsEnabled: boolean;
  stripeRequirementsCurrentlyDue: string[];
  stripeRequirementsPastDue: string[];
  stripeRequirementsPendingVerification: string[];
  stripeOnboardingCompletedAt: Date | null;
  stripePayoutScheduleConfiguredAt: Date | null;
  stripeSyncGeneration: number;
  stripeSyncCompletedGeneration: number;
};

export type ScoutOnboardingProgressStep = {
  key: "terms" | "handbook" | "profile" | "headshot" | "service" | "identity" | "payouts";
  label: string;
  complete: boolean;
  href: string;
  actionLabel: string;
};

export type ScoutOnboardingProgress = {
  completedCount: number;
  totalCount: number;
  percentComplete: number;
  ready: boolean;
  steps: ScoutOnboardingProgressStep[];
  nextStep: ScoutOnboardingProgressStep | null;
};

function stripeIdentityIsVerified(input: ScoutOnboardingProgressInput) {
  const providerMatchesAccountVersion = (input.stripeAccountApiVersion === "v1" && input.identityProvider === "stripe_connect_v1")
    || (input.stripeAccountApiVersion === "v2" && input.identityProvider === "stripe_connect_v2");
  return input.identityCheck === "clear"
    && providerMatchesAccountVersion
    && Boolean(input.identityVerificationReference?.trim())
    && Boolean(input.identityVerifiedName?.trim())
    && Boolean(input.identityVerifiedAt)
    && input.identityVerifiedBy === null
    && Boolean(input.stripeAccountId);
}

function payoutAction(input: ScoutOnboardingProgressInput) {
  if (!input.stripeAccountId) return "Set up Stripe payouts";
  if (input.stripeConnectStatus === "pending") return "Check Stripe status";
  return "Continue Stripe setup";
}

function stripePayoutIsReady(input: ScoutOnboardingProgressInput, expectedLivemode: boolean) {
  return Boolean(
    input.stripeAccountId
    && (input.stripeAccountApiVersion === "v1" || input.stripeAccountApiVersion === "v2")
    && input.stripeAccountLivemode === expectedLivemode
    && input.stripeConnectStatus === "ready"
    && input.stripeDetailsSubmitted
    && input.stripeTransfersActive
    && input.payoutsEnabled
    && input.stripeOnboardingCompletedAt
    && input.stripePayoutScheduleConfiguredAt
    && input.stripeSyncCompletedGeneration === input.stripeSyncGeneration
    && input.stripeRequirementsCurrentlyDue.length === 0
    && input.stripeRequirementsPastDue.length === 0
    && input.stripeRequirementsPendingVerification.length === 0
  );
}

export function buildScoutOnboardingProgress(
  input: ScoutOnboardingProgressInput,
  expectedStripeLivemode: boolean,
): ScoutOnboardingProgress {
  const stripeActionLabel = payoutAction(input);
  const steps: ScoutOnboardingProgressStep[] = [
    {
      key: "terms",
      label: "Marketplace terms accepted",
      complete: input.legalVersion === LEGAL_VERSION && Boolean(input.legalAcceptedAt),
      href: "/legal/accept",
      actionLabel: "Review marketplace terms",
    },
    {
      key: "handbook",
      label: "Scout Handbook acknowledged",
      complete: input.handbookVersion === SCOUT_HANDBOOK_VERSION && Boolean(input.handbookAcceptedAt),
      href: "/dashboard/scout/handbook",
      actionLabel: "Review Scout Handbook",
    },
    {
      key: "profile",
      label: "Contact information and legal name completed",
      complete: Boolean(
        input.firstName?.trim()
        && input.lastName?.trim()
        && (input.phone?.replace(/\D/g, "").length ?? 0) >= 10
        && input.verificationConsentedAt,
      ),
      href: "/dashboard/scout/settings#scout-contact",
      actionLabel: "Complete your profile",
    },
    {
      key: "headshot",
      label: "Profile headshot uploaded",
      complete: Boolean(input.headshotPath),
      href: "/dashboard/scout/settings#scout-headshot",
      actionLabel: "Upload your headshot",
    },
    {
      key: "service",
      label: "Service area, vehicle, and mission choices saved",
      complete: Boolean(
        /^\d{5}$/.test(input.homeZip?.trim() ?? "")
        && [10, 25, 50, 75].includes(input.serviceRadiusMiles)
        && input.vehicleType?.trim()
        && (input.canSee || input.canMove || input.canMeet),
      ),
      href: "/dashboard/scout/settings#scout-service",
      actionLabel: "Complete mission preferences",
    },
    {
      key: "identity",
      label: "Identity verified securely by Stripe",
      complete: stripeIdentityIsVerified(input),
      href: "/dashboard/scout/earnings",
      actionLabel: stripeActionLabel,
    },
    {
      key: "payouts",
      label: "Stripe payout account ready",
      complete: stripePayoutIsReady(input, expectedStripeLivemode),
      href: "/dashboard/scout/earnings",
      actionLabel: stripeActionLabel,
    },
  ];
  const completedCount = steps.filter((step) => step.complete).length;
  return {
    completedCount,
    totalCount: steps.length,
    percentComplete: Math.round((completedCount / steps.length) * 100),
    ready: completedCount === steps.length,
    steps,
    nextStep: steps.find((step) => !step.complete) ?? null,
  };
}
