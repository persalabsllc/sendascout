import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SCOUT_HANDBOOK_VERSION,
  hasCurrentScoutHandbookAcceptance,
} from "../lib/scout-handbook.ts";

function source(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const schema = source("db/schema.ts");
const migration = source("db/migrations/0017_scout_handbook_acceptance.sql");
const migrationJournal = source("db/migrations/meta/_journal.json");
const onboardingForm = source("components/onboarding-form.tsx");
const onboardingAction = source("app/actions/onboarding.ts");
const handbookAction = source("app/actions/scout-handbook.ts");
const handbookPage = source("app/dashboard/scout/handbook/page.tsx");
const dashboardShell = source("components/scout-dashboard-shell.tsx");
const desktopDashboard = source("components/dashboard.tsx");
const mobileNav = source("components/mobile-dashboard-nav.tsx");
const scoutOverview = source("app/dashboard/scout/page.tsx");
const missionBoard = source("app/dashboard/scout/missions/page.tsx");
const missionPage = source("app/dashboard/missions/[id]/page.tsx");
const missionMap = source("app/api/mission-map/route.ts");
const missionActions = source("app/actions/missions.ts");
const notifications = source("lib/notifications.ts");
const claimReadiness = source("lib/scout-claim-readiness.ts");
const notificationCenter = source("app/dashboard/notifications/page.tsx");
const preferredScoutRequest = source("app/request/page.tsx");

test("Scout Handbook acceptance is current only for the active version and a recorded timestamp", () => {
  const acceptedAt = new Date("2026-09-01T12:00:00.000Z");
  assert.equal(hasCurrentScoutHandbookAcceptance({ handbookVersion: SCOUT_HANDBOOK_VERSION, handbookAcceptedAt: acceptedAt }), true);
  assert.equal(hasCurrentScoutHandbookAcceptance({ handbookVersion: SCOUT_HANDBOOK_VERSION, handbookAcceptedAt: acceptedAt.toISOString() }), true);
  assert.equal(hasCurrentScoutHandbookAcceptance({ handbookVersion: "2026-08-01-v0", handbookAcceptedAt: acceptedAt }), false);
  assert.equal(hasCurrentScoutHandbookAcceptance({ handbookVersion: SCOUT_HANDBOOK_VERSION, handbookAcceptedAt: null }), false);
  assert.equal(hasCurrentScoutHandbookAcceptance({ handbookVersion: null, handbookAcceptedAt: acceptedAt }), false);
  assert.equal(hasCurrentScoutHandbookAcceptance(null), false);
});

test("the handbook migration is additive, audited, versioned, and does not fabricate legacy acceptance", () => {
  assert.match(migration, /ALTER TABLE "scout_profiles" ADD COLUMN "handbook_version" text/);
  assert.match(migration, /ALTER TABLE "scout_profiles" ADD COLUMN "handbook_accepted_at" timestamp with time zone/);
  assert.match(migration, /scout_profiles_handbook_acceptance_check/);
  assert.match(migration, /CREATE TABLE "scout_handbook_acceptances"/);
  assert.match(migration, /"source" text NOT NULL/);
  assert.match(migration, /CHECK \("source" IN \('onboarding', 'dashboard'\)\)/);
  assert.match(migration, /CREATE UNIQUE INDEX "scout_handbook_acceptances_user_version_idx"/);
  assert.doesNotMatch(migration, /\bUPDATE\s+"?scout_profiles"?/i);
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\s+"?scout_handbook_acceptances"?/i);
  assert.match(migrationJournal, /"tag": "0017_scout_handbook_acceptance"/);

  assert.match(schema, /handbookVersion: text\("handbook_version"\)/);
  assert.match(schema, /handbookAcceptedAt: timestamp\("handbook_accepted_at"/);
  assert.match(schema, /export const scoutHandbookAcceptances = pgTable\("scout_handbook_acceptances"/);
  assert.match(schema, /source: text\("source"\)\.notNull\(\)/);
  assert.match(schema, /scout_handbook_acceptances_source_check/);
});

test("Scout onboarding requires an explicit handbook acknowledgement and records the server-owned version", () => {
  assert.match(onboardingForm, /Review the Scout Handbook/);
  assert.match(onboardingForm, /handbookAccepted: false/);
  assert.match(onboardingForm, /step === 3 && !scout\.handbookAccepted/);
  assert.match(onboardingForm, /<ScoutHandbookContent variant="reader" \/>/);
  assert.match(onboardingForm, /required type="checkbox" checked=\{value\.handbookAccepted\}/);
  assert.match(onboardingForm, /SCOUT_HANDBOOK_VERSION/);

  assert.match(onboardingAction, /handbookAccepted: boolean/);
  assert.match(onboardingAction, /if \(!input\.handbookAccepted\) throw new Error/);
  assert.match(onboardingAction, /handbookVersion: SCOUT_HANDBOOK_VERSION/);
  assert.match(onboardingAction, /handbookAcceptedAt: now/);
  assert.match(onboardingAction, /db\.insert\(scoutHandbookAcceptances\)\.values\(/);
  assert.match(onboardingAction, /source: "onboarding"/);
  assert.match(onboardingAction, /userAgent: requestHeaders\.get\("user-agent"\)/);
  assert.doesNotMatch(onboardingAction, /input\.handbookVersion/);
});

test("the handbook stays accessible from every Scout dashboard navigation", () => {
  for (const navigation of [dashboardShell, desktopDashboard, mobileNav]) {
    assert.match(navigation, /\/dashboard\/scout\/handbook/);
  }
  assert.match(dashboardShell, /active: [^\n]*"handbook"/);
  assert.match(handbookPage, /ScoutDashboardShell/);
  assert.match(handbookPage, /active="handbook"/);
  assert.match(handbookPage, /ScoutHandbookContent/);
  assert.match(handbookPage, /acceptScoutHandbook/);
  assert.match(handbookPage, /handbookAcknowledgement/);
});

test("overview and Mission Board expose matching open missions while the handbook gates claiming", () => {
  for (const page of [scoutOverview, missionBoard]) {
    assert.match(page, /hasCurrentScoutHandbookAcceptance\(profile\)/);
    assert.match(page, /scoutCanBrowseOpenMissions\(user, profile\)/);
    assert.match(page, /eq\(missions\.scoutId, user\.id\)/);
    assert.match(page, /eq\(missions\.status, "open"\)/);
  }
  assert.match(scoutOverview, /scoutHandbookAccepted=\{handbookAccepted\}/);
  assert.match(desktopDashboard, /scoutOnboardingProgress && <ScoutOnboardingProgressTracker/);
  assert.match(missionBoard, /ScoutHandbookRequiredBanner/);
  assert.doesNotMatch(missionBoard, /before open missions appear/i);
  assert.match(missionBoard, /Browse matching opportunities while you finish onboarding/);
  assert.match(desktopDashboard, /Review the Scout Handbook before claiming one/);
});

test("direct mission and approximate map allow browse-only Scouts while preserving claim gates", () => {
  const assignedMissionBranch = missionPage.indexOf("mission.scoutId === user.id");
  const openMissionBranch = missionPage.indexOf('mission.status === "open"');
  const browseMissionGate = missionPage.indexOf("scoutCanBrowseOpenMissions(user, profile)");
  assert.ok(assignedMissionBranch >= 0 && assignedMissionBranch < openMissionBranch && openMissionBranch < browseMissionGate);
  assert.match(missionPage, /canClaim = profile\.status === "approved"[\s\S]*scoutReadyForApproval\(\{ \.\.\.profile, \.\.\.user \}, LEGAL_VERSION, getStripeLivemode\(\)\)/);
  assert.doesNotMatch(missionPage, /redirect\(`\/dashboard\/scout\/handbook/);

  const assignedMapAccess = missionMap.indexOf("mission.scoutId === user.id");
  const openMapBranch = missionMap.indexOf('mission.status === "open"');
  const browseMapGate = missionMap.indexOf("scoutCanBrowseOpenMissions(user, profile)");
  assert.ok(assignedMapAccess >= 0 && assignedMapAccess < openMapBranch && openMapBranch < browseMapGate);
  assert.doesNotMatch(missionMap, /hasCurrentScoutHandbookAcceptance|scoutConnectReady/);
  assert.match(missionMap, /planningPrecision = profile\?\.status === "approved" \? 3 : 2/);
  assert.match(missionMap, /if \(!allowed\) return NextResponse\.json\([^\n]*status: 403/);
});

test("claiming has both an application precheck and handbook checks inside both atomic locks", () => {
  const claimStart = missionActions.indexOf("export async function claimMission");
  const nextAction = missionActions.indexOf("export async function updateMissionStatus", claimStart);
  const claimSource = missionActions.slice(claimStart, nextAction);
  const assignedActionSource = missionActions.slice(nextAction);

  assert.match(claimSource, /hasCurrentScoutHandbookAcceptance\(profile\)/);
  assert.match(claimSource, /Review and acknowledge the current Scout Handbook before claiming missions\./);
  assert.equal((claimSource.match(/approved_profile\.handbook_version = \$\{SCOUT_HANDBOOK_VERSION\}/g) ?? []).length, 2);
  assert.equal((claimSource.match(/approved_profile\.handbook_accepted_at IS NOT NULL/g) ?? []).length, 2);
  assert.doesNotMatch(assignedActionSource.slice(0, assignedActionSource.indexOf("export async function")), /hasCurrentScoutHandbookAcceptance/);
  assert.match(assignedActionSource, /mission\.scoutId !== user\.id/);
});

test("new mission alerts and preferred Scout options require the current handbook", () => {
  assert.ok((notifications.match(/scoutClaimReadinessConditions\(stripeLivemode\)/g) ?? []).length >= 2);
  assert.match(claimReadiness, /eq\(scoutProfiles\.handbookVersion, SCOUT_HANDBOOK_VERSION\)/);
  assert.match(claimReadiness, /isNotNull\(scoutProfiles\.handbookAcceptedAt\)/);
  assert.match(handbookAction, /await alertScoutToOpenMissions\(user\.id\)/);

  assert.match(preferredScoutRequest, /scoutClaimReadinessConditions\(getStripeLivemode\(\)\)/);
  assert.match(onboardingAction, /scoutClaimReadinessConditions\(getStripeLivemode\(\)\)/);
});

test("historical open-mission notices stay hidden until the current handbook is accepted", () => {
  assert.match(notificationCenter, /hasCurrentScoutHandbookAcceptance\(scoutProfileRows\[0\]\)/);
  assert.match(notificationCenter, /canBrowseOpen && handbookAccepted \? undefined : ne\(notifications\.kind, "new_mission"\)/);
  assert.match(notificationCenter, /visibilityFilter/);
});

test("dashboard acceptance is audited, refreshes eligibility, and only redirects to safe Scout paths", () => {
  assert.match(handbookAction, /formData\.get\("handbookAcknowledgement"\) !== "accepted"/);
  assert.match(handbookAction, /db\.insert\(scoutHandbookAcceptances\)\.values\(/);
  assert.match(handbookAction, /source: "dashboard"/);
  assert.match(handbookAction, /handbookVersion: SCOUT_HANDBOOK_VERSION/);
  assert.match(handbookAction, /handbookAcceptedAt: now/);
  assert.match(handbookAction, /\.onConflictDoNothing\(\)/);
  assert.match(handbookAction, /revalidatePath\("\/dashboard\/scout\/missions"\)/);
  assert.match(handbookAction, /await alertScoutToOpenMissions\(user\.id\)/);
  assert.match(handbookAction, /redirect\(safeScoutReturnPath\(formData\.get\("next"\)\)\)/);
  assert.match(handbookAction, /value\.startsWith\("\/dashboard\/scout\/"\)/);
  assert.ok(handbookAction.includes("/^\\/dashboard\\/missions\\/[0-9a-f-]+$/i"));
  assert.match(handbookAction, /return "\/dashboard\/scout"/);
});
