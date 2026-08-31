"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireAppUser } from "@/lib/app-user";
import { createScoutStripeAccountLink, createScoutStripeDashboardLink, syncScoutStripeAccount, type ScoutPayoutOwnerType } from "@/lib/stripe-connect-service";

type StripeLinkResult = { ok: true; url: string } | { ok: false; error: string };

export async function startScoutStripeOnboarding(payoutOwnerType?: ScoutPayoutOwnerType): Promise<StripeLinkResult> {
  try {
    const user = await requireAppUser("scout");
    if (user.role !== "scout") throw new Error("Only Scout accounts can set up payouts.");
    if (payoutOwnerType !== undefined && payoutOwnerType !== "individual" && payoutOwnerType !== "company") {
      throw new Error("Choose a valid payout account type.");
    }
    return { ok: true, url: await createScoutStripeAccountLink(user.id, payoutOwnerType) };
  } catch (error) {
    unstable_rethrow(error);
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
