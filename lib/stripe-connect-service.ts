import "server-only";

import { and, asc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/db";
import { scoutProfiles, users } from "@/db/schema";
import { scoutConnectReady, summarizeV1ConnectAccount, summarizeV2ConnectAccount, type StripeConnectSummary } from "@/lib/stripe-connect";
import { alertScoutToOpenMissions } from "@/lib/notifications";
import { stripeBalanceSettingsUseRequiredFridaySchedule } from "@/lib/stripe-payout-schedule";
import { getAppUrl, getStripe, getStripeLivemode, stripeErrorDetails } from "@/lib/stripe";

type AccountApiVersion = "v1" | "v2";
export type ScoutPayoutOwnerType = "individual" | "company";

const SCOUT_SERVICE_DESCRIPTION = "Independent local task services performed through the Send a Scout marketplace, including pickup and delivery, site visits, photos, and appointment attendance.";

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
    const apiVersion = (row.profile.stripeAccountApiVersion ?? "v1") as AccountApiVersion;
    const livemode = getStripeLivemode();
    if (row.profile.stripeAccountLivemode !== null && row.profile.stripeAccountLivemode !== livemode) {
      throw new Error("This environment is connected to a different Stripe mode. Use an isolated test or live database for Scout payouts.");
    }
    if (!row.profile.stripeAccountApiVersion) {
      await db.update(scoutProfiles).set({
        stripeAccountApiVersion: apiVersion,
        stripeConnectStatus: "pending",
        updatedAt: new Date(),
      }).where(eq(scoutProfiles.id, row.profile.id));
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

export async function createScoutStripeAccountLink(userId: string, payoutOwnerType?: ScoutPayoutOwnerType) {
  const stripe = getStripe();
  const account = await getOrCreateScoutStripeAccount(userId, payoutOwnerType);
  const appUrl = getAppUrl();
  const refreshUrl = `${appUrl}/api/stripe/connect/refresh`;
  const returnUrl = `${appUrl}/api/stripe/connect/return`;

  if (account.apiVersion === "v2") {
    const link = await stripe.v2.core.accountLinks.create({
      account: account.accountId,
      use_case: {
        type: account.profile.stripeDetailsSubmitted ? "account_update" : "account_onboarding",
        ...(account.profile.stripeDetailsSubmitted ? {
          account_update: {
            configurations: ["recipient"],
            collection_options: { fields: "eventually_due", future_requirements: "include" },
            refresh_url: refreshUrl,
            return_url: returnUrl,
          },
        } : {
          account_onboarding: {
            configurations: ["recipient"],
            collection_options: { fields: "eventually_due", future_requirements: "include" },
            refresh_url: refreshUrl,
            return_url: returnUrl,
          },
        }),
      },
    });
    return link.url;
  }

  const link = await stripe.accountLinks.create({
    account: account.accountId,
    type: "account_onboarding",
    collection_options: { fields: "eventually_due", future_requirements: "include" },
    refresh_url: refreshUrl,
    return_url: returnUrl,
  });
  return link.url;
}

export async function syncScoutStripeAccount(userId: string) {
  const db = getDb();
  const [profile] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.userId, userId)).limit(1);
  if (!profile?.stripeAccountId || !profile.stripeAccountApiVersion) return profile ?? null;
  return syncStripeAccountProfile(profile.stripeAccountId, profile.stripeAccountApiVersion as AccountApiVersion);
}

export async function syncStripeAccountById(accountId: string) {
  const [profile] = await getDb().select().from(scoutProfiles).where(eq(scoutProfiles.stripeAccountId, accountId)).limit(1);
  if (!profile?.stripeAccountApiVersion) return null;
  return syncStripeAccountProfile(accountId, profile.stripeAccountApiVersion as AccountApiVersion);
}

export async function reconcileScoutPayoutReadiness(limit = 25) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await getDb().select({ accountId: scoutProfiles.stripeAccountId }).from(scoutProfiles)
    .where(and(
      isNotNull(scoutProfiles.stripeAccountId),
      or(
        isNull(scoutProfiles.stripePayoutScheduleConfiguredAt),
        isNull(scoutProfiles.stripeConnectSyncedAt),
        lt(scoutProfiles.stripeConnectSyncedAt, cutoff),
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
        accountId: row.accountId,
        error: stripeErrorDetails(error),
      });
    }
  }
  return { found: rows.length, synced, errors };
}

async function syncStripeAccountProfile(accountId: string, apiVersion: AccountApiVersion, requestedOwnerType?: ScoutPayoutOwnerType) {
  const stripe = getStripe();
  let summary: StripeConnectSummary;
  let actualOwnerType: string | null | undefined;
  if (apiVersion === "v2") {
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.recipient", "identity", "requirements", "future_requirements"],
    });
    actualOwnerType = account.identity?.entity_type;
    summary = summarizeV2ConnectAccount(account);
  } else {
    const account = await stripe.accounts.retrieve(accountId);
    actualOwnerType = account.business_type;
    summary = summarizeV1ConnectAccount(account);
  }
  if (requestedOwnerType && actualOwnerType !== requestedOwnerType) {
    throw new Error("This payout account was already created with a different legal account type. Refresh the page and continue the existing Stripe setup.");
  }
  if (summary.livemode !== getStripeLivemode()) throw new Error("The saved Stripe payout account belongs to a different Stripe mode.");

  const db = getDb();
  const [existing] = await db.select().from(scoutProfiles).where(eq(scoutProfiles.stripeAccountId, accountId)).limit(1);
  if (!existing) return null;
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
      console.error("Stripe payout schedule could not be configured", { accountId, error: stripeErrorDetails(error) });
      if (!authoritativeNoncomplianceObserved) {
        payoutScheduleConfiguredAt = existing.stripePayoutScheduleConfiguredAt;
      }
    }
  }

  const now = new Date();
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
    stripeOnboardingCompletedAt: summary.status === "ready" ? existing.stripeOnboardingCompletedAt ?? now : existing.stripeOnboardingCompletedAt,
    stripePayoutScheduleConfiguredAt: payoutScheduleConfiguredAt,
    updatedAt: now,
  }).where(eq(scoutProfiles.id, existing.id)).returning();
  if (updated && updated.status === "approved" && !wasReady && scoutConnectReady(updated, expectedLivemode)) {
    try {
      await alertScoutToOpenMissions(updated.userId);
    } catch (error) {
      console.warn("Scout payouts became ready, but existing mission alerts could not be backfilled", error);
    }
  }
  return updated ?? null;
}

export async function createScoutStripeDashboardLink(userId: string) {
  const profile = await syncScoutStripeAccount(userId);
  if (!profile?.stripeAccountId) throw new Error("Set up your Stripe payout account first.");
  const link = await getStripe().accounts.createLoginLink(profile.stripeAccountId);
  return link.url;
}
