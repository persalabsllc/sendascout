import Link from "next/link";
import { IconArrowRight, IconWallet } from "@tabler/icons-react";

export function ScoutPayoutRequiredBanner({ applicationApproved }: { applicationApproved: boolean }) {
  return <Link
    className="scout-payout-required-banner"
    href="/dashboard/scout/earnings"
    aria-label="Finish Stripe payout setup before claiming a mission"
  >
    <span className="scout-payout-required-icon"><IconWallet aria-hidden="true" size={25} /></span>
    <div>
      <strong>Finish payout setup before claiming</strong>
      <p>{applicationApproved
        ? "You can browse matching opportunities now. Claiming unlocks after Stripe confirms where Send a Scout can send your earnings."
        : "You can browse matching opportunities now. Claiming unlocks after approval and Stripe payout readiness."}</p>
    </div>
    <span className="scout-payout-required-action">Set up payouts <IconArrowRight aria-hidden="true" size={17} /></span>
  </Link>;
}
