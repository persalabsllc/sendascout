import { requireAppUser } from "@/lib/app-user";
import { scoutConnectReady } from "@/lib/stripe-connect";
import { syncScoutStripeAccount } from "@/lib/stripe-connect-service";
import { getAppUrl, getStripeLivemode } from "@/lib/stripe";

export async function GET() {
  try {
    const user = await requireAppUser("scout");
    const profile = await syncScoutStripeAccount(user.id);
    const state = profile && scoutConnectReady(profile, getStripeLivemode()) ? "ready" : "returned";
    return Response.redirect(`${getAppUrl()}/dashboard/scout/earnings?connect=${state}`, 303);
  } catch (error) {
    console.error("Stripe Account Link return sync failed", error);
    return Response.redirect(`${getAppUrl()}/dashboard/scout/earnings?connect=error`, 303);
  }
}
