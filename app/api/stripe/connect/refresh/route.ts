import { requireAppUser } from "@/lib/app-user";
import { createScoutStripeAccountLink } from "@/lib/stripe-connect-service";
import { getAppUrl } from "@/lib/stripe";

export async function GET() {
  try {
    const user = await requireAppUser("scout");
    return Response.redirect(await createScoutStripeAccountLink(user.id, undefined, "refresh"), 303);
  } catch (error) {
    console.error("Stripe Account Link refresh failed", error);
    return Response.redirect(`${getAppUrl()}/dashboard/scout/earnings?connect=error`, 303);
  }
}
