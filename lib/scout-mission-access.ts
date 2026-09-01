const BROWSE_ELIGIBLE_SCOUT_STATUSES = new Set(["applicant", "review", "approved"]);

export function scoutCanBrowseOpenMissions(
  user: { role: string; status: string } | null | undefined,
  profile: { status: string } | null | undefined,
) {
  return Boolean(
    user?.role === "scout"
    && user.status === "active"
    && profile
    && BROWSE_ELIGIBLE_SCOUT_STATUSES.has(profile.status),
  );
}
