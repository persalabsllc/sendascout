import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { validateScoutHeadshotBytes } from "../lib/scout-headshot.ts";
import { SCOUT_HEADSHOT_MAX_BYTES } from "../lib/scout-headshot-policy.ts";

const profileAction = readFileSync(new URL("../app/actions/profile.ts", import.meta.url), "utf8");
const uploadRoute = readFileSync(new URL("../app/api/scout-headshot/upload/route.ts", import.meta.url), "utf8");
const settingsForm = readFileSync(new URL("../components/scout-settings-form.tsx", import.meta.url), "utf8");

test("profile headshots must decode completely and match their declared image format", async () => {
  const jpeg = await sharp({
    create: { width: 320, height: 320, channels: 3, background: "#4c8f83" },
  }).jpeg().toBuffer();

  assert.deepEqual(await validateScoutHeadshotBytes(jpeg, "image/jpeg"), {
    width: 320,
    height: 320,
    format: "jpeg",
  });
  await assert.rejects(() => validateScoutHeadshotBytes(jpeg, "image/png"), /complete, readable/);
  await assert.rejects(() => validateScoutHeadshotBytes(jpeg.subarray(0, Math.floor(jpeg.length / 2)), "image/jpeg"), /complete, readable/);
  await assert.rejects(() => validateScoutHeadshotBytes(Buffer.from("not an image"), "image/jpeg"), /complete, readable/);
});

test("profile headshots reject unusably small images and oversized payloads", async () => {
  const tinyPng = await sharp({
    create: { width: 96, height: 96, channels: 4, background: "#ffffff" },
  }).png().toBuffer();

  await assert.rejects(() => validateScoutHeadshotBytes(tinyPng, "image/png"), /at least 160 by 160 pixels/);
  await assert.rejects(
    () => validateScoutHeadshotBytes(Buffer.alloc(SCOUT_HEADSHOT_MAX_BYTES + 1), "image/jpeg"),
    /no larger than 5 MB/,
  );
});

test("saving a headshot validates private Blob bytes before the CAS write and cleans only unreferenced files", () => {
  const validation = profileAction.indexOf("await validateScoutHeadshotBytes(bytes, blob.blob.contentType)");
  const persistence = profileAction.indexOf("const [savedPhoto] = await db.update(scoutProfiles)");
  assert.ok(validation > 0 && persistence > validation);
  assert.match(profileAction, /bytes\.byteLength !== blob\.blob\.size/);
  assert.match(profileAction, /deleteScoutHeadshotIfUnreferenced/);
  assert.match(profileAction, /eq\(scoutProfiles\.headshotPath, pathname\)/);
  assert.match(profileAction, /eq\(missions\.scoutHeadshotPathSnapshot, pathname\)/);
  assert.match(profileAction, /headshotPath} IS NOT DISTINCT FROM \$\{existing\.headshotPath\}/);
  assert.match(profileAction, /NOT EXISTS \([\s\S]*active_mission/);
  assert.match(profileAction, /active_scout\.role = 'scout'/);
  assert.match(profileAction, /active_scout\.status = 'active'/);
  assert.match(uploadRoute, /user\.role !== "scout" \|\| user\.status !== "active"/);
});

test("headshot copy describes a recognition photo, not a separately verified badge", () => {
  assert.match(settingsForm, /customers know whom to expect/);
  assert.match(settingsForm, /Stripe payout identity verification remains separate/);
  assert.doesNotMatch(settingsForm, /verified photo|badge.*re-review/i);
  assert.doesNotMatch(profileAction, /verified photo customers rely on/i);
  assert.doesNotMatch(uploadRoute, /verified photo customers rely on/i);
});
