import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settlement = readFileSync(new URL("../lib/stripe-settlement.ts", import.meta.url), "utf8");

test("settlement reconciliation iterates typed database result rows", () => {
  const completedMissionReconciliation = settlement.slice(
    settlement.indexOf("export async function reconcileCompletedMissionSettlements"),
    settlement.indexOf("export async function enqueueMissionSettlement"),
  );
  const casePayoutReconciliation = settlement.slice(
    settlement.indexOf("export async function reconcileCasePayouts"),
    settlement.indexOf("export async function enqueueCasePayout"),
  );

  for (const reconciliation of [completedMissionReconciliation, casePayoutReconciliation]) {
    assert.match(reconciliation, /execute<\{ id: string \}>\(sql`/);
    assert.match(reconciliation, /const rows = candidateResult\.rows;/);
    assert.doesNotMatch(reconciliation, /as unknown as Array<\{ id: string \}>/);
    assert.match(reconciliation, /for \(const row of rows\)/);
  }
});
