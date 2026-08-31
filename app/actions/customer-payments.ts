"use server";

import { unstable_rethrow } from "next/navigation";
import { requireAppUser } from "@/lib/app-user";
import { createHostedCheckoutForPayment } from "@/lib/stripe-payments";

type ContinuePaymentResult =
  | { ok: true; url: string | null }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function continueCustomerPayment(paymentId: string): Promise<ContinuePaymentResult> {
  try {
    const user = await requireAppUser("customer");
    if (user.role !== "customer") throw new Error("Only customer accounts can continue a payment.");
    if (!UUID_PATTERN.test(paymentId)) throw new Error("Invalid payment request.");

    const url = await createHostedCheckoutForPayment(paymentId, user.id);
    if (url) {
      const destination = new URL(url);
      if (destination.protocol !== "https:" || (destination.hostname !== "checkout.stripe.com" && !destination.hostname.endsWith(".stripe.com"))) {
        throw new Error("Stripe returned an unexpected checkout destination.");
      }
    }

    return { ok: true, url };
  } catch (error) {
    unstable_rethrow(error);
    console.error("Customer payment recovery could not start", error);
    return { ok: false, error: "Secure checkout could not open. Refresh the page and try again, or contact support if the problem continues." };
  }
}
