const BROWSE_ELIGIBLE_SCOUT_STATUSES = new Set(["applicant", "review", "approved"]);

export function scoutCanBrowseOpenMissions(profile: { status: string } | null | undefined) {
  return Boolean(profile && BROWSE_ELIGIBLE_SCOUT_STATUSES.has(profile.status));
}

