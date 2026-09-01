"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getDb } from "@/db";
import { scoutProfiles } from "@/db/schema";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import { isUnsupportedStripeEmbeddedBrowser } from "@/lib/stripe-connect-browser";
import { createScoutStripeAccountLink, createScoutStripeDashboardLink, syncScoutStripeAccount, syncStripeAccountById, type ScoutPayoutOwnerType } from "@/lib/stripe-connect-service";
import { logStripeConnectTelemetry } from "@/lib/stripe-connect-telemetry";

type StripeLinkResult = { ok: true; url: string } | { ok: false; error: string; reason?: "embedded_browser" };

export async function startScoutStripeOnboarding(payoutOwnerType?: ScoutPayoutOwnerType): Promise<StripeLinkResult> {
  let userId: string | null = null;
  try {
    const user = await requireAppUser("scout");
    userId = user.id;
    if (user.role !== "scout") throw new Error("Only Scout accounts can set up payouts.");
    if (payoutOwnerType !== undefined && payoutOwnerType !== "individual" && payoutOwnerType !== "company") {
      throw new Error("Choose a valid payout account type.");
    }
    const requestHeaders = await headers();
    if (isUnsupportedStripeEmbeddedBrowser(requestHeaders.get("user-agent"))) {
      logStripeConnectTelemetry("start_blocked_embedded_browser", { userId, source: "start" });
      return {
        ok: false,
        reason: "embedded_browser",
        error: "Open Send a Scout in Safari or Chrome to finish secure Stripe setup.",
      };
    }
    return { ok: true, url: await createScoutStripeAccountLink(user.id, payoutOwnerType) };
  } catch (error) {
    unstable_rethrow(error);
    logStripeConnectTelemetry("start_failed", { userId, source: "start" });
    console.error("Scout Stripe onboarding could not start", error);
    return { ok: false, error: "Stripe payout setup could not start. Please try again or contact support." };
  }
}

export async function refreshScoutStripeStatus(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await requireAppUser("scout");
    if (user.role !== "scout") throw new Error("Only Scout accounts can refresh payout status.");
    await syncScoutStripeAccount(user.id);
    revalidatePath("/dashboard/scout");
    revalidatePath("/dashboard/scout/earnings");
    revalidatePath("/dashboard/scout/missions");
    revalidatePath("/dashboard/scout/settings");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Scout Stripe status could not refresh", error);
    return { ok: false, error: "Stripe payout status could not refresh. Please try again or contact support." };
  }
}

export async function adminRefreshScoutStripeStatus(profileId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireAdminUser();
    const [profile] = await getDb().select({
      id: scoutProfiles.id,
      stripeAccountId: scoutProfiles.stripeAccountId,
    }).from(scoutProfiles).where(eq(scoutProfiles.id, profileId)).limit(1);
    if (!profile) return { ok: false, error: "Scout profile not found." };
    if (!profile.stripeAccountId) return { ok: false, error: "This Scout has not created a Stripe payout account yet." };

    const synced = await syncStripeAccountById(profile.stripeAccountId);
    if (!synced || synced.id !== profile.id) return { ok: false, error: "The Scout payout account could not be synchronized safely." };

    revalidatePath("/control-room");
    revalidatePath("/control-room/scouts");
    revalidatePath("/dashboard/scout");
    revalidatePath("/dashboard/scout/earnings");
    revalidatePath("/dashboard/scout/missions");
    revalidatePath("/dashboard/scout/settings");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Control Room could not refresh Scout Stripe status", { profileId, error });
    return { ok: false, error: "Stripe payout status could not be refreshed. Try again or check the production logs." };
  }
}

export async function openScoutStripeDashboard(): Promise<StripeLinkResult> {
  try {
    const user = await requireAppUser("scout");
    if (user.role !== "scout") throw new Error("Only Scout accounts can manage payouts.");
    return { ok: true, url: await createScoutStripeDashboardLink(user.id) };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Scout Stripe dashboard could not open", error);
    return { ok: false, error: "Stripe payout management could not open. Please try again or contact support." };
  }
}
