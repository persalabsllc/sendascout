export type ScoutApprovalInput = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  legalVersion: string | null;
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
  stripeTransfersActive: boolean;
  payoutsEnabled: boolean;
  stripePayoutScheduleConfiguredAt: Date | null;
};

export type ScoutApprovalCheck = { key: string; label: string; complete: boolean };

export function scoutApprovalChecklist(input: ScoutApprovalInput, currentLegalVersion: string, expectedLivemode: boolean): ScoutApprovalCheck[] {
  return [
    { key: "identity", label: "Government ID and verified legal name recorded", complete: input.identityCheck === "clear" && Boolean(input.identityVerifiedName?.trim() && input.identityVerifiedAt) },
    { key: "terms", label: "Current marketplace terms accepted", complete: input.legalVersion === currentLegalVersion },
    { key: "name", label: "First and last legal name provided", complete: Boolean(input.firstName?.trim() && input.lastName?.trim()) },
    { key: "phone", label: "Mobile number provided", complete: (input.phone?.replace(/\D/g, "").length ?? 0) >= 10 },
    { key: "headshot", label: "Current profile headshot uploaded", complete: Boolean(input.headshotPath) },
    { key: "zone", label: "Valid service ZIP and travel zone selected", complete: /^\d{5}$/.test(input.homeZip?.trim() ?? "") },
    { key: "vehicle", label: "Vehicle access recorded", complete: Boolean(input.vehicleType?.trim()) },
    { key: "missions", label: "At least one mission type selected", complete: input.canSee || input.canMove || input.canMeet },
    { key: "consent", label: "Verification consent recorded", complete: Boolean(input.verificationConsentedAt) },
    { key: "payouts", label: "Stripe payout account and Friday schedule ready", complete: Boolean(input.stripeAccountId && input.stripeAccountLivemode === expectedLivemode && input.stripeConnectStatus === "ready" && input.stripeTransfersActive && input.payoutsEnabled && input.stripePayoutScheduleConfiguredAt) },
  ];
}

export function scoutReadyForApproval(input: ScoutApprovalInput, currentLegalVersion: string, expectedLivemode: boolean) {
  return scoutApprovalChecklist(input, currentLegalVersion, expectedLivemode).every((item) => item.complete);
}
