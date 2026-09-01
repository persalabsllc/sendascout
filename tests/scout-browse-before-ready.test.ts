import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { scoutCanBrowseOpenMissions } from "../lib/scout-mission-access.ts";

function source(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function section(value: string, start: string, end?: string) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = end ? value.indexOf(end, startIndex + start.length) : -1;
  return value.slice(startIndex, endIndex === -1 ? undefined : endIndex);
}

const scoutOverview = source("app/dashboard/scout/page.tsx");
const missionBoard = source("app/dashboard/scout/missions/page.tsx");
const missionPage = source("app/dashboard/missions/[id]/page.tsx");
const missionMap = source("app/api/mission-map/route.ts");
const missionWorkspace = source("components/mission-workspace.tsx");
const missionActions = source("app/actions/missions.ts");
const notifications = source("lib/notifications.ts");
const notificationPage = source("app/dashboard/notifications/page.tsx");
const claimReadiness = source("lib/scout-claim-readiness.ts");
const activeScout = { role: "scout", status: "active" };

test("only active Scout users in browse-eligible profile states can browse open missions", () => {
  for (const status of ["applicant", "review", "approved"]) {
    assert.equal(scoutCanBrowseOpenMissions(activeScout, { status }), true, `${status} should browse open missions`);
  }
  for (const status of ["paused", "rejected", "unknown"]) {
    assert.equal(scoutCanBrowseOpenMissions(activeScout, { status }), false, `${status} should not browse open missions`);
  }
  assert.equal(scoutCanBrowseOpenMissions({ role: "scout", status: "suspended" }, { status: "approved" }), false);
  assert.equal(scoutCanBrowseOpenMissions({ role: "customer", status: "active" }, { status: "approved" }), false);
  assert.equal(scoutCanBrowseOpenMissions({ role: "admin", status: "active" }, { status: "approved" }), false);
  assert.equal(scoutCanBrowseOpenMissions(activeScout, null), false);
  assert.equal(scoutCanBrowseOpenMissions(null, { status: "approved" }), false);

  assert.match(missionBoard, /profile\.status === "paused"[\s\S]*New opportunities are hidden/);
  assert.match(missionBoard, /profile\.status === "rejected"[\s\S]*not eligible to browse or claim/);
  assert.match(missionBoard, /canBrowseOpen && !handbookAccepted/);
  assert.match(missionBoard, /canBrowseOpen && !payoutReady/);
  assert.match(missionWorkspace, /!assigned && !canClaim && claimRequirement/);
  assert.match(source("components/dashboard.tsx"), /<EmptyMissions profileStatus=\{profileStatus\}/);
  assert.match(source("components/dashboard.tsx"), /profileStatus === "paused" \? "New opportunities are paused"/);
  assert.match(scoutOverview, /scoutCanBrowseOpenMissions\(user, profile\)/);
});

test("overview and Mission Board browse paid open missions independently of claim readiness", () => {
  for (const page of [scoutOverview, missionBoard]) {
    assert.match(page, /const canBrowseOpen = scoutCanBrowseOpenMissions\(user, profile\)/);
    assert.match(page, /canBrowseOpen\s*\?/);
    assert.match(page, /eq\(missions\.scoutId, user\.id\)/);
    assert.match(page, /eq\(missions\.status, "open"\)/);
    assert.match(page, /eq\(missions\.paymentStatus, "paid"\)/);
    assert.match(page, /isMissionEligibleForScout|scoutMissionEligibility/);
  }

  assert.match(scoutOverview, /const payoutReady = scoutConnectReady\(profile, stripeLivemode\)/);
  assert.match(scoutOverview, /const handbookAccepted = hasCurrentScoutHandbookAcceptance\(profile\)/);
  assert.doesNotMatch(scoutOverview, /const canBrowseOpen = [^\n]*(?:payoutReady|handbookAccepted)/);
  assert.doesNotMatch(missionBoard, /const canBrowseOpen = [^\n]*(?:payoutReady|handbookAccepted)/);
});

test("every browse surface preserves paid, matching, assigned-work, and private first-look rules", () => {
  for (const page of [scoutOverview, missionBoard]) {
    assert.match(page, /isNull\(missions\.preferredScoutId\)/);
    assert.match(page, /eq\(missions\.preferredScoutId, user\.id\)/);
    assert.match(page, /isNotNull\(missions\.preferredScoutBroadcastAt\)/);
    assert.doesNotMatch(page, /isNull\(missions\.preferredScoutExclusiveUntil\)/);
    assert.match(page, /lte\(missions\.preferredScoutExclusiveUntil, sql`now\(\)`\)/);
  }
  assert.match(scoutOverview, /canBrowseOpen[\s\S]*\? db\.select\(\)\.from\(missions\)[\s\S]*: db\.select\(\)\.from\(missions\)\.where\(and\(isNull\(missions\.archivedAt\), eq\(missions\.scoutId, user\.id\)\)\)/);
  assert.match(missionBoard, /canBrowseOpen \? or\([\s\S]*\) : eq\(missions\.scoutId, user\.id\)/);

  assert.match(missionPage, /mission\.scoutId === user\.id/);
  assert.match(missionPage, /user\.role === "scout" && user\.status === "active"/);
  assert.match(missionPage, /scoutCanBrowseOpenMissions\(user, profile\)/);
  assert.match(missionPage, /itinerary\.some\(\(leg\) => leg\.paymentStatus !== "paid"\)/);
  assert.match(missionPage, /claimWindows\.some\(\(window\) => !window\.available\)/);
  assert.doesNotMatch(missionPage, /preferredScoutExclusiveUntil\} IS NULL/);
  assert.match(missionPage, /itinerary\.some\(\(leg\) => !isMissionEligibleForScout\(leg, profile\)\)/);

  assert.match(missionMap, /mission\.scoutId === user\.id/);
  assert.match(missionMap, /user\.role === "scout" && user\.status === "active"/);
  assert.match(missionMap, /scoutCanBrowseOpenMissions\(user, profile\)/);
  assert.match(missionMap, /const privateFirstLook = itinerary\.some/);
  assert.match(missionMap, /leg\.preferredScoutId !== user\.id/);
  assert.match(missionMap, /!leg\.preferredScoutExclusiveUntil \|\| leg\.preferredScoutExclusiveUntil\.getTime\(\) > Date\.now\(\)/);
  assert.match(missionMap, /itinerary\.every\(\(leg\) => leg\.paymentStatus === "paid" && isMissionEligibleForScout\(leg, profile\)\)/);
});

test("browse-only mission details stay redacted and use a coarser planning map", () => {
  assert.match(missionPage, /const showFullAddress = role !== "scout" \|\| mission\.scoutId === user\.id/);
  assert.match(missionPage, /: `\$\{mission\.city\}, \$\{mission\.state\} \$\{mission\.zip\}`/);
  assert.match(missionPage, /instructions: showFullAddress \? mission\.instructions : "Full instructions become available after you claim the mission\."/);
  assert.match(missionPage, /pickupInstructions: showFullAddress \? mission\.pickupInstructions : null/);
  assert.match(missionPage, /deliveryInstructions: showFullAddress \? mission\.deliveryInstructions : null/);
  assert.match(missionPage, /maximumCustomerPriceCents: role !== "scout" \? mission\.maximumCustomerPriceCents : null/);
  assert.match(missionPage, /bundleDiscountCents: role !== "scout" \? bundle\.bundleDiscountCents : 0/);
  assert.match(missionPage, /customerPriceCents: role !== "scout" \? bundle\.customerPriceCents : 0/);
  assert.match(missionWorkspace, /role !== "scout" && bundle\.bundleDiscountCents > 0/);
  assert.doesNotMatch(missionWorkspace, /Scout pay is not reduced/);
  assert.match(missionPage, /planningMapPrecision = profile\.status === "approved" \? 3 : 2/);
  assert.match(missionMap, /planningPrecision = profile\?\.status === "approved" \? 3 : 2/);
  assert.match(missionMap, /let routePolyline = planningView \? null : mission\.routePolyline/);

  assert.match(missionWorkspace, /!assigned && !canClaim && claimRequirement/);
  assert.match(missionWorkspace, /You can review this mission now/);
  assert.match(missionWorkspace, /Claiming remains locked until your Scout checklist is complete/);
  assert.match(missionWorkspace, /role === "scout" && !assigned \? "Planning view · the exact address unlocks after claiming"/);
});

test("direct browsing and claim readiness are separate decisions", () => {
  const browseGuard = missionPage.indexOf("scoutCanBrowseOpenMissions(user, profile)");
  const claimDecision = missionPage.indexOf('canClaim = profile.status === "approved"', browseGuard);
  assert.ok(browseGuard >= 0 && claimDecision > browseGuard);

  const claimReadiness = missionPage.slice(claimDecision, missionPage.indexOf("if (!canClaim)", claimDecision));
  assert.match(claimReadiness, /profile\.status === "approved"/);
  assert.match(claimReadiness, /scoutReadyForApproval\(\{ \.\.\.profile, \.\.\.user \}, LEGAL_VERSION, getStripeLivemode\(\)\)/);
});

test("new-mission notifications follow the same active Scout browse policy", () => {
  assert.match(scoutOverview, /canBrowseOpen && handbookAccepted \? undefined : ne\(notifications\.kind, "new_mission"\)/);
  assert.match(scoutOverview, /item\.kind === "new_mission" && \(!canBrowseOpen \|\| !handbookAccepted\)/);
  assert.match(notificationPage, /scoutCanBrowseOpenMissions\(user, scoutProfileRows\[0\]\)/);
  assert.match(notificationPage, /canBrowseOpen && handbookAccepted \? undefined : ne\(notifications\.kind, "new_mission"\)/);
});

test("claimMission retains prechecks and two independent atomic readiness locks", () => {
  const claimSource = section(missionActions, "export async function claimMission", "export async function updateMissionStatus");

  assert.match(claimSource, /profile\.status !== "approved"/);
  assert.match(claimSource, /hasCurrentScoutHandbookAcceptance\(profile\)/);
  assert.match(claimSource, /scoutReadyForApproval\(\{/);
  assert.match(claimSource, /missionsToCheck\.some\(\(candidate\) => candidate\.paymentStatus !== "paid"\)/);
  assert.match(claimSource, /missionsToCheck\.some\(\(candidate\) => !isMissionEligibleForScout\(candidate, profile\)\)/);
  assert.match(claimSource, /This mission is currently in another Scout’s private first-look window\./);
  assert.doesNotMatch(claimSource, /scoutCanBrowseOpenMissions/);
  assert.match(claimSource, /&& \(!candidate\.preferredScoutExclusiveUntil \|\| candidate\.preferredScoutExclusiveUntil\.getTime\(\) > now\.getTime\(\)\)/);
  assert.match(claimSource, /locked_part\.preferred_scout_exclusive_until IS NULL[\s\S]*OR locked_part\.preferred_scout_exclusive_until > \$\{now\}/);
  assert.match(claimSource, /candidate\.preferred_scout_exclusive_until IS NOT NULL[\s\S]*candidate\.preferred_scout_exclusive_until <= \$\{now\}/);

  const atomicRequirements = [
    "approved_profile.status = 'approved'",
    "approved_profile.identity_check = 'clear'",
    "approved_profile.identity_verified_name IS NOT NULL",
    "approved_profile.identity_verified_at IS NOT NULL",
    "approved_profile.headshot_path IS NOT NULL",
    "approved_profile.handbook_version = ${SCOUT_HANDBOOK_VERSION}",
    "approved_profile.handbook_accepted_at IS NOT NULL",
    "approved_profile.stripe_account_id IS NOT NULL",
    "approved_profile.stripe_account_livemode = ${stripeLivemode}",
    "approved_profile.stripe_connect_status = 'ready'",
    "approved_profile.stripe_transfers_active = TRUE",
    "approved_profile.payouts_enabled = TRUE",
    "approved_profile.stripe_payout_schedule_configured_at IS NOT NULL",
  ];
  for (const requirement of atomicRequirements) {
    assert.equal(claimSource.split(requirement).length - 1, 2, `${requirement} must exist in both atomic claim paths`);
  }
});

test("mission notifications remain restricted to Scouts who are claim-ready", () => {
  const newMissionAlerts = section(notifications, "export async function alertEligibleScouts", "export async function alertScoutToOpenMissions");
  const backfillAlerts = section(notifications, "export async function alertScoutToOpenMissions");
  const readinessPredicates = [
    /inArray\(scoutProfiles\.status, allowedStatuses\)/,
    /eq\(scoutProfiles\.handbookVersion, SCOUT_HANDBOOK_VERSION\)/,
    /isNotNull\(scoutProfiles\.handbookAcceptedAt\)/,
    /eq\(scoutProfiles\.stripeAccountLivemode, expectedLivemode\)/,
    /eq\(scoutProfiles\.stripeConnectStatus, "ready"\)/,
    /eq\(scoutProfiles\.stripeTransfersActive, true\)/,
    /eq\(scoutProfiles\.payoutsEnabled, true\)/,
    /isNotNull\(scoutProfiles\.stripePayoutScheduleConfiguredAt\)/,
    /isNotNull\(scoutProfiles\.stripeAccountId\)/,
  ];
  for (const alertSource of [newMissionAlerts, backfillAlerts]) {
    assert.match(alertSource, /scoutClaimReadinessConditions\(stripeLivemode\)/);
  }
  for (const predicate of readinessPredicates) assert.match(claimReadiness, predicate);

  assert.match(notificationPage, /canBrowseOpen && handbookAccepted \? undefined : ne\(notifications\.kind, "new_mission"\)/);
  assert.match(scoutOverview, /canBrowseOpen && handbookAccepted \? undefined : ne\(notifications\.kind, "new_mission"\)/);
});
