"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight } from "@tabler/icons-react";
import { continueCustomerPayment } from "@/app/actions/customer-payments";

export function ContinuePaymentButton({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function continuePayment() {
    setError("");
    startTransition(async () => {
      const result = await continueCustomerPayment(paymentId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.url) {
        window.location.assign(result.url);
        return;
      }
      router.refresh();
    });
  }

  return <div className="list-meta">
    <button className="claim-button" type="button" disabled={pending} onClick={continuePayment}>
      {pending ? "Opening…" : "Continue payment"} {!pending && <IconArrowRight size={14} />}
    </button>
    {error && <small role="alert">{error}</small>}
  </div>;
}
