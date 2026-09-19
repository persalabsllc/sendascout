export function bookingMissionStatus(status: string, paymentStatus?: string, confirmationError = false) {
  if (status !== "draft") return titleCase(status);
  if (confirmationError) return "Payment confirmation delayed";
  if (paymentStatus === "paid") return "Paused by support";
  if (["partially_refunded", "refunded", "disputed"].includes(paymentStatus ?? "")) return "Payment under review";
  if (paymentStatus === "processing") return "Confirming payment";
  return "Awaiting payment confirmation";
}

export function bookingBlockedReason(status: string, paymentStatus: string, confirmationError = false) {
  if (confirmationError) return "Stripe confirmation could not be applied. Check Stripe to reconcile the existing payment; do not ask the customer to pay again.";
  if (status !== "draft") return null;
  if (paymentStatus === "paid") return "Payment received. This funded mission was pulled from Scouts; an administrator must reopen it.";
  if (["partially_refunded", "refunded", "disputed"].includes(paymentStatus)) return "Payment requires financial review before this mission can be released.";
  return "Not live: booking payment has not been confirmed in the ledger. Check Stripe before retrying or cancelling.";
}

export function paymentStatusLabel(status: string) {
  return ({ requires_action: "Action needed", canceled: "Canceled", disputed: "Under review" } as Record<string, string>)[status] ?? titleCase(status);
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Drizzle errors include SQL and bound parameters. Do not put them into alerts
// or client-visible messages; preserve only a useful error class/database code.
export function paymentErrorDiagnostic(error: unknown) {
  let current = error;
  let code: string | null = null;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && /^[A-Za-z0-9_]{1,60}$/.test(current.code)) code = current.code;
    current = "cause" in current ? current.cause : null;
  }
  return { code, message: code ? `Payment confirmation failed (${code}). Retry reconciliation of the existing Stripe payment.` : "Payment confirmation could not finish. Retry reconciliation of the existing Stripe payment." };
}
