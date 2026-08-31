import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function shouldMigrateProduction(environment = process.env) {
  return environment.VERCEL === "1" && environment.VERCEL_ENV === "production";
}

function runCommand(command, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        signal
          ? `${command} was terminated by ${signal}.`
          : `${command} exited with code ${code ?? "unknown"}.`,
      ));
    });
  });
}

export async function runVercelBuild({
  environment = process.env,
  runner = runCommand,
} = {}) {
  if (shouldMigrateProduction(environment)) {
    console.log("Backing up the Production schema before migration...");
    await runner(process.execPath, ["scripts/backup-production-schema.mjs"], environment);
    console.log("Checking Production database migrations before building...");
    await runner(process.execPath, ["scripts/migrate.mjs"], environment);
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runner(npmCommand, ["run", "build"], environment);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  await runVercelBuild();
}
