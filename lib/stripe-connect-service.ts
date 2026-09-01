import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { scoutProfiles, users } from "@/db/schema";
import {
  scoutConnectReady,
  summarizeV1ConnectAccount,
  summarizeV2ConnectAccount,
  verifiedIdentityFromV1Account,
  verifiedIdentityFromV2Account,
  type StripeConnectSummary,
  type StripeVerifiedIdentity,
} from "@/lib/stripe-connect";
import { alertScoutToOpenMissions } from "@/lib/notifications";
import { tryAutoApproveScout } from "@/lib/scout-auto-approval";
import { stripeBalanceSettingsUseRequiredFridaySchedule } from "@/lib/stripe-payout-schedule";
import { logStripeConnectTelemetry, stripeConnectTelemetryRef } from "@/lib/stripe-connect-telemetry";
import { getAppUrl, getStripe, getStripeLivemode, stripeErrorDetails } from "@/lib/stripe";

type AccountApiVersion = "v1" | "v2";
export type ScoutPayoutOwnerType = "individual" | "company";

const MAX_COMPANY_PERSONS_TO_SCAN = 100;
const STRIPE_SYNC_LEASE_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_SYNC_PASSES = 4;

const SCOUT_SERVICE_DESCRIPTION = "Independent local task services performed through the Send a Scout marketplace, including pickup and delivery, site visits, photos, and appointment attendance.";

function storedAccountApiVersion(value: string | null): AccountApiVersion | null {
  return value === "v1" || value === "v2" ? value : null;
}

/**
 * Accounts saved before API-version tracking were all Accounts v1. Repair the
 * discriminator with a compare-and-set and simultaneously advance sync demand
 * so a crash after this write cannot expose the old readiness snapshot. A
 * concurrent repair may win; in that case its stored version is authoritative.
 */
async function resolveHistoricalStripeAccountApiVersion(accountId: string): Promise<AccountApiVersion | null> {
  const db = getDb();
  const [existing] = await db.select({
    id: scoutProfiles.id,
    apiVersion: scoutProfiles.stripeAccountApiVersion,
  }).from(scoutProfiles).where(eq(scoutProfiles.stripeAccountId, accountId)).limit(1);
  if (!existing) return null;
  const storedVersion = storedAccountApiVersion(existing.apiVersion);
  if (storedVersion) return storedVersion;

  const [repaired] = await db.update(scoutProfiles).set({
    stripeAccountApiVersion: "v1",
    stripeSyncGeneration: sql`${scoutProfiles.stripeSyncGeneration} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(scoutProfiles.id, existing.id),
    eq(scoutProfiles.stripeAccountId, accountId),
    isNull(scoutProfiles.stripeAccountApiVersion),
  )).returning({ apiVersion: scoutProfiles.stripeAccountApiVersion });
  if (repaired) return "v1";

  const [current] = await db.select({ apiVersion: scoutProfiles.stripeAccountApiVersion })
    .from(scoutProfiles).where(and(
      eq(scoutProfiles.id, existing.id),
      eq(scoutProfiles.stripeAccountId, accountId),
    )).limit(1);
  return storedAccountApiVersion(current?.apiVersion ?? null);
}

export async function getOrCreateScoutStripeAccount(userId: string, payoutOwnerType?: ScoutPayoutOwnerType) {
  const db = getDb();
  const [row] = await db.select({ user: users, profile: scoutProfiles })
    .from(scoutProfiles)
    .innerJoin(users, eq(users.id, scoutProfiles.userId))
    .where(eq(scoutProfiles.userId, userId))
    .limit(1);
  if (!row) throw new Error("Complete your Scout application before setting up payouts.");
  if (row.profile.status === "rejected") throw new Error("This Scout application is not eligible for payout setup.");
  if (row.profile.stripeAccountId) {
    const apiVersion = storedAccountApiVersion(row.profile.stripeAccountApiVersion)
      ?? await resolveHistoricalStripeAccountApiVersion(row.profile.stripeAccountId);
    if (!apiVersion) throw new Error("The saved Stripe payout account version could not be resolved.");
    const livemode = getStripeLivemode();
    if (row.profile.stripeAccountLivemode !== null && row.profile.stripeAccountLivemode !== livemode) {
      throw new Error("This environment is connected to a different Stripe mode. Use an isolated test or live database for Scout payouts.");
    }
    const synced = await syncStripeAccountProfile(row.profile.stripeAccountId, apiVersion, payoutOwnerType);
    if (!synced) throw new Error("The saved Stripe payout account could not be synchronized.");
    return {
      accountId: row.profile.stripeAccountId,
      apiVersion,
      profile: synced,
    };
  }

  if (!payoutOwnerType) throw new Error("Choose whether Stripe should pay you personally or pay your registered business.");

  const stripe = getStripe();
  const displayName = [row.user.firstName, row.user.lastName].filter(Boolean).join(" ") || "Send a Scout Scout";
  let accountId: string;
  let apiVersion: AccountApiVersion;
  try {
    const account = await stripe.v2.core.accounts.create({
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: {
              stripe_transfers: { requested: true },
            },
          },
        },
      },
      contact_email: row.user.email,
      contact_phone: row.user.phone ?? undefined,
      dashboard: "express",
      defaults: {
        currency: "usd",
        locales: ["en-US"],
        profile: {
          product_description: SCOUT_SERVICE_DESCRIPTION,
        },
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      display_name: payoutOwnerType === "individual" ? displayName : undefined,
      identity: payoutOwnerType === "individual" ? {
        country: "us",
        entity_type: "individual",
        individual: {
          email: row.user.email,
          given_name: row.user.firstName ?? undefined,
          phone: row.user.phone ?? undefined,
          surname: row.user.lastName ?? undefined,
        },
      } : {
        country: "us",
        entity_type: "company",
      },
      include: ["configuration.recipient", "requirements", "future_requirements"],
      metadata: {
        sendascout_user_id: row.user.id,
        sendascout_scout_profile_id: row.profile.id,
      },
    }, { idempotencyKey: `scout:${row.profile.id}:recipient-account:v2` });
    accountId = account.id;
    apiVersion = "v2";
  } catch (error) {
    const details = stripeErrorDetails(error);
    if (details.code !== "accounts_v2_access_blocked") throw error;
    const account = await stripe.accounts.create({
      business_profile: {
        product_description: SCOUT_SERVICE_DESCRIPTION,
      },
      business_type: payoutOwnerType,
      capabilities: { transfers: { requested: true } },
      controller: {
        fees: { payer: "application" },
        losses: { payments: "application" },
        requirement_collection: "stripe",
        stripe_dashboard: { type: "express" },
      },
      country: "US",
      email: row.user.email,
      individual: payoutOwnerType === "individual" ? {
        email: row.user.email,
        first_name: row.user.firstName ?? undefined,
        last_name: row.user.lastName ?? undefined,
        phone: row.user.phone ?? undefined,
      } : undefined,
      metadata: {
        sendascout_user_id: row.user.id,
        sendascout_scout_profile_id: row.profile.id,
      },
    }, { idempotencyKey: `scout:${row.profile.id}:recipient-account:v1` });
    accountId = account.id;
    apiVersion = "v1";
  }

  const [saved] = await db.update(scoutProfiles).set({
    stripeAccountId: accountId,
    stripeAccountApiVersion: apiVersion,
    stripeAccountLivemode: getStripeLivemode(),
    stripeConnectStatus: "onboarding",
    stripeConnectSyncedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(scoutProfiles.userId, userId), isNull(scoutProfiles.stripeAccountId))).returning();

  if (saved) return { accountId, apiVersion, profile: saved };
  const [current] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, userId)).limit(1);
  if (!current?.stripeAccountId || !current.stripeAccountApiVersion) throw new Error("Payout setup changed in another window. Refresh and try again.");
  return {
    accountId: current.stripeAccountId,
    apiVersion: current.stripeAccountApiVersion as AccountApiVersion,
    profile: current,
  };
}

export async function createScoutStripeAccountLink(
  userId: string,
  payoutOwnerType?: ScoutPayoutOwnerType,
  source: "start" | "refresh" = "start",
) {
  const stripe = getStripe();
  const account = await getOrCreateScoutStripeAccount(userId, payoutOwnerType);
  const appUrl = getAppUrl();
  const refreshUrl = `${appUrl}/api/stripe/connect/refresh`;
  const returnUrl = `${appUrl}/api/stripe/connect/return`;
  const flow = account.profile.stripeDetailsSubmitted ? "update" : "onboarding";

  if (account.apiVersion === "v2") {
    const link = await stripe.v2.core.accountLinks.create({
      account: account.accountId,
      use_case: {
        type: account.profile.stripeDetailsSubmitted ? "account_update" : "account_onboarding",
        ...(account.profile.stripeDetailsSubmitted ? {
          account_update: {
            configurations: ["recipient"],
            collection_options: { fields: "currently_due" },
            refresh_url: refreshUrl,
            return_url: returnUrl,
          },
        } : {
          account_onboarding: {
            configurations: ["recipient"],
            collection_options: { fields: "currently_due" },
            refresh_url: refreshUrl,
            return_url: returnUrl,
          },
        }),
      },
    });
    logStripeConnectTelemetry("link_created", {
      userId,
      accountId: account.accountId,
      apiVersion: account.apiVersion,
      source,
      flow,
      status: account.profile.stripeConnectStatus,
      detailsSubmitted: account.profile.stripeDetailsSubmitted,
      currentlyDueCount: account.profile.stripeRequirementsCurrentlyDue.length,
      pastDueCount: account.profile.stripeRequirementsPastDue.length,
      pendingVerificationCount: account.profile.stripeRequirementsPendingVerification.length,
      futureDueCount: account.profile.stripeRequirementsFutureDue.length,
    });
    return link.url;
  }

  const link = await stripe.accountLinks.create({
    account: account.accountId,
    type: "account_onboarding",
    collection_options: { fields: "currently_due" },
    refresh_url: refreshUrl,
    return_url: returnUrl,
  });
  logStripeConnectTelemetry("link_created", {
    userId,
    accountId: account.accountId,
    apiVersion: account.apiVersion,
    source,
    flow,
    status: account.profile.stripeConnectStatus,
    detailsSubmitted: account.profile.stripeDetailsSubmitted,
    currentlyDueCount: account.profile.stripeRequirementsCurrentlyDue.length,
    pastDueCount: account.profile.stripeRequirementsPastDue.length,
    pendingVerificationCount: account.profile.stripeRequirementsPendingVerification.length,
    futureDueCount: account.profile.stripeRequirementsFutureDue.length,
  });
  return link.url;
}

export async function syncScoutStripeAccount(userId: string) {
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, userId)).limit(1);
  if (!profile?.stripeAccountId) return profile ?? null;
  return syncStripeAccountById(profile.stripeAccountId);
}

export async function syncStripeAccountById(accountId: string) {
  const apiVersion = await resolveHistoricalStripeAccountApiVersion(accountId);
  if (!apiVersion) return null;
  return syncStripeAccountProfile(accountId, apiVersion);
}

export async function reconcileScoutPayoutReadiness(limit = 25) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await getDb().select({ accountId: scoutProfiles.stripeAccountId }).from(scoutProfiles)
    .where(and(
      isNotNull(scoutProfiles.stripeAccountId),
      or(
        isNull(scoutProfiles.stripePayoutScheduleConfiguredAt),
        sql`${scoutProfiles.stripeSyncCompletedGeneration} < ${scoutProfiles.stripeSyncGeneration}`,
        isNull(scoutProfiles.stripeConnectSyncedAt),
        lt(scoutProfiles.stripeConnectSyncedAt, cutoff),
        ne(scoutProfiles.identityCheck, "clear"),
        isNull(scoutProfiles.stripeAccountApiVersion),
        isNull(scoutProfiles.identityProvider),
        notInArray(scoutProfiles.identityProvider, ["stripe_connect_v1", "stripe_connect_v2"]),
        isNull(scoutProfiles.identityVerificationReference),
        isNull(scoutProfiles.identityVerifiedName),
        isNull(scoutProfiles.identityVerifiedAt),
        isNotNull(scoutProfiles.identityVerifiedBy),
        sql`NOT (
          (${scoutProfiles.stripeAccountApiVersion} = 'v1' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v1')
          OR (${scoutProfiles.stripeAccountApiVersion} = 'v2' AND ${scoutProfiles.identityProvider} = 'stripe_connect_v2')
        )`,
      ),
    ))
    .orderBy(asc(scoutProfiles.stripeConnectSyncedAt))
    .limit(Math.max(1, Math.min(100, limit)));
  let synced = 0;
  let errors = 0;
  for (const row of rows) {
    if (!row.accountId) continue;
    try {
      if (await syncStripeAccountById(row.accountId)) synced += 1;
    } catch (error) {
      errors += 1;
      console.error("Stripe payout readiness reconciliation failed", {
        accountRef: stripeConnectTelemetryRef(row.accountId),
        error: stripeErrorDetails(error),
      });
    }
  }
  return { found: rows.length, synced, errors };
}

async function syncStripeAccountProfile(accountId: string, apiVersion: AccountApiVersion, requestedOwnerType?: ScoutPayoutOwnerType) {
  const db = getDb();
  // Every webhook, browser return and hourly recovery records durable demand
  // for a fresh provider read. Only one worker owns the account lease; if it
  // crashes, the uncompleted generation and expiring lease remain recoverable.
  const [requested] = await db.update(scoutProfiles).set({
    stripeSyncGeneration: sql`${scoutProfiles.stripeSyncGeneration} + 1`,
  }).where(eq(scoutProfiles.stripeAccountId, accountId)).returning({ id: scoutProfiles.id });
  if (!requested) return null;
  const leaseToken = randomUUID();
  const leaseStartedAt = new Date();
  const [leased] = await db.update(scoutProfiles).set({
    stripeSyncLeaseToken: leaseToken,
    stripeSyncLeaseExpiresAt: new Date(leaseStartedAt.getTime() + STRIPE_SYNC_LEASE_MS),
  }).where(and(
    eq(scoutProfiles.id, requested.id),
    or(
      isNull(scoutProfiles.stripeSyncLeaseToken),
      isNull(scoutProfiles.stripeSyncLeaseExpiresAt),
      sql`${scoutProfiles.stripeSyncLeaseExpiresAt} <= ${leaseStartedAt}`,
    ),
  )).returning({ id: scoutProfiles.id });
  // The current lease owner will observe this request generation before it can
  // release the lease. Returning null also prevents callers from acting on an
  // older locally stored ready state while that reconciliation is pending.
  if (!leased) return null;

  const releaseLease = () => db.update(scoutProfiles).set({
    stripeSyncLeaseToken: null,
    stripeSyncLeaseExpiresAt: null,
  }).where(and(
    eq(scoutProfiles.id, requested.id),
    eq(scoutProfiles.stripeSyncLeaseToken, leaseToken),
  ));

  try {
    const stripe = getStripe();
    for (let pass = 0; pass < MAX_CONCURRENT_SYNC_PASSES; pass += 1) {
      const [existing] = await db.select().from(scoutProfiles).where(and(
        eq(scoutProfiles.id, requested.id),
        eq(scoutProfiles.stripeSyncLeaseToken, leaseToken),
      )).limit(1);
      if (!existing) return null;
      const syncGeneration = existing.stripeSyncGeneration;
      let summary: StripeConnectSummary;
      let verifiedIdentity: StripeVerifiedIdentity | null;
      let actualOwnerType: string | null | undefined;
      if (apiVersion === "v2") {
        const account = await stripe.v2.core.accounts.retrieve(accountId, {
          include: ["configuration.recipient", "identity", "requirements", "future_requirements"],
        });
        actualOwnerType = account.identity?.entity_type;
        summary = summarizeV2ConnectAccount(account);
        const representative = account.identity?.entity_type === "individual" || summary.status !== "ready"
          ? undefined
          : await findV2PrimaryRepresentative(stripe, accountId);
        verifiedIdentity = verifiedIdentityFromV2Account(account, summary.status === "ready", representative);
      } else {
        const account = await stripe.accounts.retrieve(accountId);
        actualOwnerType = account.business_type;
        summary = summarizeV1ConnectAccount(account);
        const representative = account.business_type === "company" && summary.status === "ready"
          ? await findV1PrimaryRepresentative(stripe, accountId)
          : undefined;
        verifiedIdentity = verifiedIdentityFromV1Account(account, representative);
      }
      if (requestedOwnerType && actualOwnerType !== requestedOwnerType) {
        throw new Error("This payout account was already created with a different legal account type. Refresh the page and continue the existing Stripe setup.");
      }
      if (summary.livemode !== getStripeLivemode()) throw new Error("The saved Stripe payout account belongs to a different Stripe mode.");

      const expectedLivemode = getStripeLivemode();
      const wasReady = scoutConnectReady(existing, expectedLivemode);

      let payoutScheduleConfiguredAt: Date | null = summary.transfersActive && summary.payoutsEnabled
        ? existing.stripePayoutScheduleConfiguredAt
        : null;
      if (summary.transfersActive && summary.payoutsEnabled) {
        let authoritativeNoncomplianceObserved = false;
        try {
          const connectedRequest = apiVersion === "v2"
            ? { stripeContext: accountId }
            : { stripeAccount: accountId };
          const balanceSettings = await stripe.balanceSettings.retrieve({}, connectedRequest);
          const fridaySchedule = stripeBalanceSettingsUseRequiredFridaySchedule(balanceSettings);
          if (!fridaySchedule) {
            authoritativeNoncomplianceObserved = true;
            payoutScheduleConfiguredAt = null;
            await stripe.balanceSettings.update({
              payments: {
                payouts: {
                  schedule: {
                    interval: "weekly",
                    weekly_payout_days: ["friday"],
                  },
                },
              },
            }, connectedRequest);
          }
          // Do not trust the update response or reuse an enforcement idempotency key:
          // retrieve authoritative state so schedule drift cannot be certified by a cached response.
          const verifiedSettings = fridaySchedule
            ? balanceSettings
            : await stripe.balanceSettings.retrieve({}, connectedRequest);
          if (!stripeBalanceSettingsUseRequiredFridaySchedule(verifiedSettings)) {
            throw new Error("Stripe did not confirm the required Friday payout schedule.");
          }
          payoutScheduleConfiguredAt = new Date();
        } catch (error) {
          console.error("Stripe payout schedule could not be configured", { accountRef: stripeConnectTelemetryRef(accountId), error: stripeErrorDetails(error) });
          if (!authoritativeNoncomplianceObserved) {
            payoutScheduleConfiguredAt = existing.stripePayoutScheduleConfiguredAt;
          }
        }
      }

      const now = new Date();
      const identityProvider = `stripe_connect_${apiVersion}`;
      const identityUnchanged = Boolean(
        verifiedIdentity
        && existing.identityCheck === "clear"
        && existing.identityProvider === identityProvider
        && existing.identityVerificationReference === verifiedIdentity.reference
        && existing.identityVerifiedName === verifiedIdentity.fullName
        && existing.identityVerifiedAt,
      );
      const [updated] = await db.update(scoutProfiles).set({
        stripeConnectStatus: summary.status,
        stripeAccountLivemode: summary.livemode,
        stripeDetailsSubmitted: summary.detailsSubmitted,
        stripeTransfersActive: summary.transfersActive,
        payoutsEnabled: summary.payoutsEnabled,
        stripeRequirementsCurrentlyDue: summary.currentlyDue,
        stripeRequirementsPastDue: summary.pastDue,
        stripeRequirementsPendingVerification: summary.pendingVerification,
        stripeRequirementsFutureDue: summary.futureDue,
        stripeDisabledReason: summary.disabledReason,
        stripeConnectSyncedAt: now,
        stripeSyncCompletedGeneration: syncGeneration,
        stripeSyncLeaseToken: null,
        stripeSyncLeaseExpiresAt: null,
        stripeOnboardingCompletedAt: summary.status === "ready" ? existing.stripeOnboardingCompletedAt ?? now : existing.stripeOnboardingCompletedAt,
        stripePayoutScheduleConfiguredAt: payoutScheduleConfiguredAt,
        identityCheck: verifiedIdentity
          ? "clear"
          : summary.status === "disabled" || summary.status === "restricted"
            ? "failed"
            : summary.status === "ready"
              ? "review"
              : "pending",
        identityProvider,
        identityVerificationReference: verifiedIdentity?.reference ?? null,
        identityVerifiedName: verifiedIdentity?.fullName ?? null,
        identityVerifiedAt: verifiedIdentity ? (identityUnchanged ? existing.identityVerifiedAt : now) : null,
        identityVerifiedBy: null,
        updatedAt: now,
      }).where(and(
        eq(scoutProfiles.id, existing.id),
        eq(scoutProfiles.stripeSyncLeaseToken, leaseToken),
        eq(scoutProfiles.stripeSyncGeneration, syncGeneration),
      )).returning();
      // Another caller requested a sync while Stripe was being read. Keep the
      // same exclusive lease and fetch again; never persist the older snapshot.
      if (!updated) continue;
      logStripeConnectTelemetry("status_synced", {
        userId: updated.userId,
        accountId,
        apiVersion,
        source: "sync",
        status: updated.stripeConnectStatus,
        ready: scoutConnectReady(updated, expectedLivemode),
        detailsSubmitted: updated.stripeDetailsSubmitted,
        transfersActive: updated.stripeTransfersActive,
        payoutsEnabled: updated.payoutsEnabled,
        payoutScheduleConfigured: Boolean(updated.stripePayoutScheduleConfiguredAt),
        currentlyDueCount: updated.stripeRequirementsCurrentlyDue.length,
        pastDueCount: updated.stripeRequirementsPastDue.length,
        pendingVerificationCount: updated.stripeRequirementsPendingVerification.length,
        futureDueCount: updated.stripeRequirementsFutureDue.length,
      });
      if (updated.status === "approved" && !wasReady && scoutConnectReady(updated, expectedLivemode)) {
        try {
          await alertScoutToOpenMissions(updated.userId);
        } catch (error) {
          console.warn("Scout payouts became ready, but existing mission alerts could not be backfilled", error);
        }
      }
      await tryAutoApproveScout(updated.userId);
      return updated;
    }
    console.warn("Stripe account sync deferred after overlapping provider events", { accountRef: stripeConnectTelemetryRef(accountId) });
    await releaseLease();
    return null;
  } catch (error) {
    try {
      await releaseLease();
    } catch (releaseError) {
      console.error("Stripe sync lease could not be released", {
        accountRef: stripeConnectTelemetryRef(accountId),
        error: releaseError instanceof Error ? releaseError.message : "Unknown lease release error",
      });
    }
    throw error;
  }
}

async function findV1PrimaryRepresentative(stripe: ReturnType<typeof getStripe>, accountId: string) {
  let inspected = 0;
  for await (const person of stripe.accounts.listPersons(accountId, {
    relationship: { representative: true },
    limit: 20,
  })) {
    inspected += 1;
    if (person.relationship?.representative === true) return person;
    if (inspected >= MAX_COMPANY_PERSONS_TO_SCAN) break;
  }
  return undefined;
}

async function findV2PrimaryRepresentative(stripe: ReturnType<typeof getStripe>, accountId: string) {
  let inspected = 0;
  for await (const person of stripe.v2.core.accounts.persons.list(accountId, { limit: 20 })) {
    inspected += 1;
    if (person.relationship?.representative === true) return person;
    if (inspected >= MAX_COMPANY_PERSONS_TO_SCAN) break;
  }
  return undefined;
}

export async function createScoutStripeDashboardLink(userId: string) {
  const profile = await syncScoutStripeAccount(userId);
  if (!profile?.stripeAccountId) throw new Error("Set up your Stripe payout account first.");
  const link = await getStripe().accounts.createLoginLink(profile.stripeAccountId);
  return link.url;
}
