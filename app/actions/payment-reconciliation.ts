"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireAdminUser, requireAppUser } from "@/lib/app-user";
import { reconcileBookingPayment } from "@/lib/stripe-payment-reconciliation";
import { reportOperationalEvent } from "@/lib/observability";
import { paymentErrorDiagnostic } from "@/lib/payment-presentation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function reconcile(paymentId: string, customerId?: string) {
  if (!UUID.test(paymentId)) return { ok: false as const, error: "Invalid payment request." };
  try {
    const result = await reconcileBookingPayment(paymentId, customerId);
    revalidatePath("/dashboard/customer/payments");
    revalidatePath("/dashboard/customer");
    revalidatePath(`/dashboard/missions/${result.missionId}`);
    revalidatePath("/control-room");
    revalidatePath("/control-room/see-it");
    return { ok: true as const, status: result.status };
  } catch (error) {
    unstable_rethrow(error);
    const diagnostic = paymentErrorDiagnostic(error);
    await reportOperationalEvent({ category: "booking_payment_confirmation", message: diagnostic.message, fingerprint: `booking-confirmation:${paymentId}`, context: { paymentId, code: diagnostic.code } });
    return { ok: false as const, error: "We could not finish checking the existing payment. Please do not pay again if Stripe already charged you; support has been alerted." };
  }
}

export async function refreshCustomerBookingPayment(paymentId: string) {
  const user = await requireAppUser("customer");
  if (user.role !== "customer") return { ok: false as const, error: "Only the customer can check this payment here." };
  return reconcile(paymentId, user.id);
}

export async function adminReconcileBookingPayment(paymentId: string) {
  await requireAdminUser();
  return reconcile(paymentId);
}
