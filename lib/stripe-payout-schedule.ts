export const SCOUT_TRANSFER_RELEASE_TIMEZONE = "UTC";

type BalanceSettingsLike = {
  payments: {
    payouts: {
      status: string;
      schedule: {
        interval: string | null;
        weekly_payout_days?: string[];
      } | null;
    } | null;
  };
};

export function scoutTransferReleaseIsOpen(at: Date) {
  return !Number.isNaN(at.getTime()) && at.getUTCDay() === 5;
}

export function nextScoutTransferReleaseAt(at: Date) {
  if (Number.isNaN(at.getTime())) throw new RangeError("A valid release timestamp is required.");
  const next = new Date(at);
  next.setUTCHours(0, 0, 0, 0);
  let daysUntilFriday = (5 - next.getUTCDay() + 7) % 7;
  if (daysUntilFriday === 0) daysUntilFriday = 7;
  next.setUTCDate(next.getUTCDate() + daysUntilFriday);
  return next;
}

export function stripeBalanceSettingsUseRequiredFridaySchedule(settings: BalanceSettingsLike) {
  const payouts = settings.payments.payouts;
  const schedule = payouts?.schedule;
  return payouts?.status === "enabled"
    && schedule?.interval === "weekly"
    && schedule.weekly_payout_days?.length === 1
    && schedule.weekly_payout_days[0] === "friday";
}
