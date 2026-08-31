import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  runVercelBuild,
  shouldMigrateProduction,
} from "../scripts/vercel-build.mjs";

test("Production migrations only run inside a Vercel Production build", () => {
  assert.equal(shouldMigrateProduction({ VERCEL: "1", VERCEL_ENV: "production" }), true);
  assert.equal(shouldMigrateProduction({ VERCEL: "1", VERCEL_ENV: "preview" }), false);
  assert.equal(shouldMigrateProduction({ VERCEL_ENV: "production" }), false);
});

test("Production migration completes before the Next.js build starts", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await runVercelBuild({
    environment: { VERCEL: "1", VERCEL_ENV: "production" },
    runner: async (command: string, args: string[]) => {
      calls.push({ command, args });
    },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ["scripts/backup-production-schema.mjs"],
    ["scripts/migrate.mjs"],
    ["run", "build"],
  ]);
});

test("Preview builds never run the Production migration", async () => {
  const calls: Array<string[]> = [];
  await runVercelBuild({
    environment: { VERCEL: "1", VERCEL_ENV: "preview" },
    runner: async (_command: string, args: string[]) => {
      calls.push(args);
    },
  });

  assert.deepEqual(calls, [["run", "build"]]);
});

test("A failed Production migration prevents the application build", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    runVercelBuild({
      environment: { VERCEL: "1", VERCEL_ENV: "production" },
      runner: async (_command: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "scripts/migrate.mjs") throw new Error("migration failed");
      },
    }),
    /migration failed/,
  );

  assert.deepEqual(calls, [
    ["scripts/backup-production-schema.mjs"],
    ["scripts/migrate.mjs"],
  ]);
});

test("A failed application build is reported after a successful migration", async () => {
  await assert.rejects(
    runVercelBuild({
      environment: { VERCEL: "1", VERCEL_ENV: "production" },
      runner: async (_command: string, args: string[]) => {
        if (args[0] === "run") throw new Error("build failed");
      },
    }),
    /build failed/,
  );
});

test("Vercel uses the guarded build entrypoint", async () => {
  const vercelConfig = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercelConfig.buildCommand, "node scripts/vercel-build.mjs");
});

test("Production backup script is guarded and does not log connection values", async () => {
  const backupScript = await readFile(new URL("../scripts/backup-production-schema.mjs", import.meta.url), "utf8");
  assert.match(backupScript, /VERCEL_ENV !== "production"/);
  assert.match(backupScript, /pre_stripe_production_20260831/);
  assert.doesNotMatch(backupScript, /console\.log\([^\n]*connectionString/);
});
