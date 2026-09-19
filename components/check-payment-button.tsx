"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshCustomerBookingPayment } from "@/app/actions/payment-reconciliation";

export function CheckPaymentButton({ paymentId, autoCheck = false }: { paymentId: string; autoCheck?: boolean }) {
  const router = useRouter();
  const checked = useRef(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const check = useCallback(() => {
    startTransition(async () => {
      setMessage("");
      const result = await refreshCustomerBookingPayment(paymentId);
      setMessage(result.ok ? result.status === "paid" ? "Payment confirmed." : "Stripe checked. The payment status below is current." : result.error);
      router.refresh();
    });
  }, [paymentId, router]);
  useEffect(() => {
    if (!autoCheck || checked.current) return;
    checked.current = true;
    check();
  }, [autoCheck, check]);
  return <div className="payment-check-action">
    <button className="claim-button" type="button" disabled={pending} onClick={check}>{pending ? "Checking Stripe…" : "Check payment status"}</button>
    <small role="status" aria-live="polite">{pending ? "Checking your existing payment. This will not charge you." : message}</small>
  </div>;
}
