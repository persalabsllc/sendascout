import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceFiles = [
  "../app/actions/missions.ts",
  "../app/api/cron/auto-complete/route.ts",
  "../lib/stripe-late-payment-refunds.ts",
  "../lib/stripe-payments.ts",
  "../lib/stripe-settlement.ts",
] as const;

const sources = sourceFiles.map((file) => ({
  file,
  source: readFileSync(new URL(file, import.meta.url), "utf8"),
}));

test("captured Neon HTTP execute results use the rows collection", () => {
  for (const { file, source } of sources) {
    assert.doesNotMatch(source, /as unknown as (?:Array<|[^;\n]*\[\])/u, `${file} must not cast a raw execute result to an array`);
  }

  const missions = sources.find(({ file }) => file.endsWith("app/actions/missions.ts"))!.source;
  assert.match(missions, /claimedBundleResult\.rows\[0\]/u);
  assert.match(missions, /claimedResult\.rows\[0\]/u);
  assert.match(missions, /createdResult\.rows\[0\]/u);
  assert.match(missions, /completedResult\.rows\[0\]/u);
  assert.match(missions, /updatedBundleResult\.rows\[0\]/u);

  const cron = sources.find(({ file }) => file.endsWith("app/api/cron/auto-complete/route.ts"))!.source;
  assert.match(cron, /const completionRows = completionResult\.rows;/u);

  const lateRefunds = sources.find(({ file }) => file.endsWith("lib/stripe-late-payment-refunds.ts"))!.source;
  assert.match(lateRefunds, /const row = result\.rows\[0\];/u);

  const payments = sources.find(({ file }) => file.endsWith("lib/stripe-payments.ts"))!.source;
  assert.match(payments, /applied = appliedResult\.rows\[0\];/u);
  assert.match(payments, /const rows = result\.rows;/u);
});
