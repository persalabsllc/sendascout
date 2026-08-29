export const LEGAL_VERSION = "2026-08-29-v1";
export const TERMS_VERSION = "2026-08-29-v1";
export const PRIVACY_VERSION = "2026-08-29-v1";
export const POLICIES_VERSION = "2026-08-29-v1";

export function hasCurrentLegalAcceptance(user: { legalVersion: string | null; legalAcceptedAt: Date | null }) {
  return user.legalVersion === LEGAL_VERSION && Boolean(user.legalAcceptedAt);
}
