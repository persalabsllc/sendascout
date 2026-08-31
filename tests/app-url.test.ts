import assert from "node:assert/strict";
import test from "node:test";
import { getAppUrl } from "../lib/app-url.ts";

test("Preview uses the stable branch URL instead of a configured production URL", () => {
  assert.equal(getAppUrl({
    VERCEL_ENV: "preview",
    VERCEL_BRANCH_URL: "sendascout-git-codex-stripe-connect-persa-labs.vercel.app",
    VERCEL_URL: "sendascout-unique-persa-labs.vercel.app",
    NEXT_PUBLIC_APP_URL: "https://sendascout.com",
  }), "https://sendascout-git-codex-stripe-connect-persa-labs.vercel.app");
});

test("Preview falls back to the unique deployment URL", () => {
  assert.equal(getAppUrl({
    VERCEL_ENV: "preview",
    VERCEL_URL: "https://sendascout-unique-persa-labs.vercel.app/",
    NEXT_PUBLIC_APP_URL: "https://sendascout.com",
  }), "https://sendascout-unique-persa-labs.vercel.app");
});

test("Production ignores Preview system URLs", () => {
  assert.equal(getAppUrl({
    VERCEL_ENV: "production",
    VERCEL_BRANCH_URL: "sendascout-git-main-persa-labs.vercel.app",
    NEXT_PUBLIC_APP_URL: "https://sendascout.com/",
  }), "https://sendascout.com");
});

test("Local configuration and the production fallback remain unchanged", () => {
  assert.equal(getAppUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:3000///" }), "http://localhost:3000");
  assert.equal(getAppUrl({}), "https://sendascout.com");
});
