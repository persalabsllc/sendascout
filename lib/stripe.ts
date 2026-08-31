import "server-only";

import Stripe from "stripe";

export { getAppUrl } from "@/lib/app-url";

let stripeClient: Stripe | null = null;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe is not configured yet. Add STRIPE_SECRET_KEY before accepting payments.");

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey, {
      apiVersion: "2026-08-26.dahlia",
      appInfo: {
        name: "Send a Scout",
        url: "https://sendascout.com",
      },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  return stripeClient;
}

export function getStripeLivemode() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new Error("Stripe is not configured yet. Add STRIPE_SECRET_KEY before accepting payments.");
  if (secretKey.startsWith("sk_live_")) return true;
  if (secretKey.startsWith("sk_test_")) return false;
  throw new Error("STRIPE_SECRET_KEY must be a Stripe test or live secret key.");
}

export function stripeObjectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

export function stripeErrorDetails(error: unknown) {
  const candidate = error as {
    code?: unknown;
    type?: unknown;
    message?: unknown;
    raw?: { code?: unknown; type?: unknown; message?: unknown };
  };
  return {
    code: String(candidate.code ?? candidate.raw?.code ?? "stripe_error"),
    type: String(candidate.type ?? candidate.raw?.type ?? "StripeError"),
    message: String(candidate.message ?? candidate.raw?.message ?? "Stripe could not process the request."),
  };
}
