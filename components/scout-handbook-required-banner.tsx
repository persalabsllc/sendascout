import Link from "next/link";
import { IconArrowRight, IconBook2 } from "@tabler/icons-react";

export function ScoutHandbookRequiredBanner({ next }: { next?: string }) {
  const href = next
    ? `/dashboard/scout/handbook?next=${encodeURIComponent(next)}`
    : "/dashboard/scout/handbook";
  return <Link
    aria-label="Review and acknowledge the Scout Handbook before claiming a mission"
    className="scout-payout-required-banner scout-handbook-required-banner"
    href={href}
  >
    <span className="scout-payout-required-icon"><IconBook2 aria-hidden="true" size={25} /></span>
    <div>
      <strong>Review the Scout Handbook before claiming</strong>
      <p>You can browse missions now. Read the safety, privacy, property-care, and conduct standards before accepting one.</p>
    </div>
    <span className="scout-payout-required-action">Review handbook <IconArrowRight aria-hidden="true" size={17} /></span>
  </Link>;
}
