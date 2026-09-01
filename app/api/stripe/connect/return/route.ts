import { requireAppUser } from "@/lib/app-user";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { syncScoutStripeAccount } from "@/lib/stripe-connect-service";
import { logStripeConnectTelemetry } from "@/lib/stripe-connect-telemetry";
import { getAppUrl, getStripeLivemode } from "@/lib/stripe";

export async function GET() {
  let userId: string | null = null;
  try {
    const user = await requireAppUser("scout");
    userId = user.id;
    const profile = await syncScoutStripeAccount(user.id);
    const ready = Boolean(profile && scoutConnectReady(profile, getStripeLivemode()));
    logStripeConnectTelemetry("return_synced", {
      userId,
      accountId: profile?.stripeAccountId,
      apiVersion: profile?.stripeAccountApiVersion === "v1" || profile?.stripeAccountApiVersion === "v2" ? profile.stripeAccountApiVersion : null,
      source: "return",
      status: profile?.stripeConnectStatus,
      ready,
      detailsSubmitted: profile?.stripeDetailsSubmitted,
      transfersActive: profile?.stripeTransfersActive,
      payoutsEnabled: profile?.payoutsEnabled,
      payoutScheduleConfigured: Boolean(profile?.stripePayoutScheduleConfiguredAt),
      currentlyDueCount: profile?.stripeRequirementsCurrentlyDue.length,
      pastDueCount: profile?.stripeRequirementsPastDue.length,
      pendingVerificationCount: profile?.stripeRequirementsPendingVerification.length,
      futureDueCount: profile?.stripeRequirementsFutureDue.length,
    });
    const state = ready ? "ready" : "returned";
    return Response.redirect(`${getAppUrl()}/dashboard/scout/earnings?connect=${state}`, 303);
  } catch (error) {
    logStripeConnectTelemetry("return_failed", { userId, source: "return" });
    console.error("Stripe Account Link return sync failed", error);
    return Response.redirect(`${getAppUrl()}/dashboard/scout/earnings?connect=error`, 303);
  }
}
