import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  nextScoutTransferReleaseAt,
  scoutTransferReleaseIsOpen,
  stripeBalanceSettingsUseRequiredFridaySchedule,
} from "../lib/stripe-payout-schedule.ts";

const settlementService = readFileSync(new URL("../lib/stripe-settlement.ts", import.meta.url), "utf8");

test("Scout transfer release is open for Friday UTC only", () => {
  assert.equal(scoutTransferReleaseIsOpen(new Date("2026-09-03T23:59:59.999Z")), false);
  assert.equal(scoutTransferReleaseIsOpen(new Date("2026-09-04T00:00:00.000Z")), true);
  assert.equal(scoutTransferReleaseIsOpen(new Date("2026-09-04T23:59:59.999Z")), true);
  assert.equal(scoutTransferReleaseIsOpen(new Date("2026-09-05T00:00:00.000Z")), false);
  assert.equal(scoutTransferReleaseIsOpen(new Date("invalid")), false);
});

test("non-Friday attempts defer to the next Friday at midnight UTC", () => {
  assert.equal(nextScoutTransferReleaseAt(new Date("2026-09-03T12:30:00.000Z")).toISOString(), "2026-09-04T00:00:00.000Z");
  assert.equal(nextScoutTransferReleaseAt(new Date("2026-09-05T12:30:00.000Z")).toISOString(), "2026-09-11T00:00:00.000Z");
  assert.equal(nextScoutTransferReleaseAt(new Date("2026-09-04T12:30:00.000Z")).toISOString(), "2026-09-11T00:00:00.000Z");
  assert.throws(() => nextScoutTransferReleaseAt(new Date("invalid")), /valid release timestamp/);
});

test("authoritative Balance Settings require enabled payouts on Friday only", () => {
  const settings = (status: string, interval: string, days: string[]) => ({
    payments: { payouts: { status, schedule: { interval, weekly_payout_days: days } } },
  });
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule(settings("enabled", "weekly", ["friday"])), true);
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule(settings("disabled", "weekly", ["friday"])), false);
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule(settings("enabled", "manual", [])), false);
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule(settings("enabled", "weekly", ["monday", "friday"])), false);
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule({ payments: { payouts: null } }), false);
  assert.equal(stripeBalanceSettingsUseRequiredFridaySchedule({ payments: { payouts: { status: "enabled", schedule: null } } }), false);
});

test("transfer creation is guarded by current connected Balance Settings and a final Friday check", () => {
  const scheduleHoldSource = settlementService.slice(
    settlementService.indexOf("async function holdClaimedPaymentTransferForSchedule"),
    settlementService.indexOf("export async function processPaymentTransfer"),
  );
  const processSource = settlementService.slice(
    settlementService.indexOf("export async function processPaymentTransfer"),
    settlementService.indexOf("async function claimedTransferStillEligible"),
  );
  assert.match(settlementService, /code: "friday_release_hold"/);
  assert.match(settlementService, /balanceSettings\.retrieve\(\{\}, \{ stripeContext: claimed\.stripeAccountId \}\)/);
  assert.match(settlementService, /stripe_payout_schedule_configured_at = NULL/);
  assert.match(settlementService, /failure_code = 'payout_schedule_hold'/);
  assert.match(settlementService, /const createCheckedAt = new Date\(\);[\s\S]*scoutTransferReleaseIsOpen\(createCheckedAt\)[\s\S]*stripe\.transfers\.create/);
  assert.ok(processSource.indexOf("reconcilePaymentTransferIdentity(claimed.id)") < processSource.indexOf("const releaseCheckedAt"));
  assert.ok(processSource.indexOf("const releaseCheckedAt") < processSource.indexOf("balanceSettings.retrieve"));
  assert.ok(processSource.indexOf("balanceSettings.retrieve") < processSource.indexOf("const createCheckedAt"));
  assert.ok(processSource.indexOf("const createCheckedAt") < processSource.indexOf("stripe.transfers.create"));
  assert.match(processSource, /holdClaimedPaymentTransferForSchedule\(claimed, livemode, heldAt\)/);
  assert.match(scheduleHoldSource, /WITH held_transfer AS/);
  assert.ok(scheduleHoldSource.indexOf("UPDATE payment_transfers") < scheduleHoldSource.indexOf("UPDATE scout_profiles"));
  assert.match(scheduleHoldSource, /UPDATE scout_profiles[\s\S]*FROM held_transfer/);
});

test("new ledger rows are scheduled directly for the current or next Friday window", () => {
  assert.match(settlementService, /const nextAttemptAt = scoutTransferReleaseIsOpen\(releaseAttemptedAt\)[\s\S]*nextScoutTransferReleaseAt\(releaseAttemptedAt\)/);
  assert.match(settlementService, /status: "pending" as const,[\s\S]*nextAttemptAt/);
});

test("transfer claims serialize on the funding payment and preserve ambiguous commitments", () => {
  const claimSource = settlementService.slice(
    settlementService.indexOf("const claimQuery"),
    settlementService.indexOf("const claimStatement"),
  );
  assert.match(settlementService, /db\.\$client\.transaction\(/);
  assert.match(settlementService, /FOR UPDATE OF payment/);
  assert.match(settlementService, /isolationLevel: "Serializable"/);
  assert.match(settlementService, /isSerializationFailure\(error\)/);
  assert.match(settlementService, /let priorTransferOutcomeMayExist = previousStatus === "processing"/);
  assert.match(settlementService, /transferRequestStarted = true;[\s\S]*stripe\.transfers\.create/);
  assert.match(settlementService, /const preserveCommitment = priorTransferOutcomeMayExist[\s\S]*stripeTransferOutcomeMayBeUnknown\(error\)/);
  assert.match(settlementService, /status: preserveCommitment \? "processing" : "failed"/);
  assert.ok(claimSource.indexOf("sql`EXISTS") < claimSource.indexOf('and(eq(paymentTransfers.status, "processing")'));
});
