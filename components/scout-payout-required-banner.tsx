import Link from "next/link";
import { IconArrowRight, IconWallet } from "@tabler/icons-react";

export function ScoutPayoutRequiredBanner({ applicationApproved }: { applicationApproved: boolean }) {
  return <Link
    className="scout-payout-required-banner"
    href="/dashboard/scout/earnings"
    aria-label="Finish Stripe payout setup to unlock matching missions"
  >
    <span className="scout-payout-required-icon"><IconWallet aria-hidden="true" size={25} /></span>
    <div>
      <strong>Finish payout setup to unlock missions</strong>
      <p>{applicationApproved
        ? "Open missions stay hidden until Stripe confirms where Send a Scout can send your earnings."
        : "Matching missions appear after your application is approved and Stripe confirms where Send a Scout can send your earnings."}</p>
    </div>
    <span className="scout-payout-required-action">Set up payouts <IconArrowRight aria-hidden="true" size={17} /></span>
  </Link>;
}
