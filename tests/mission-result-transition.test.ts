import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");

test("every mission result transition aliases its raw id field", () => {
  const aliasedFields = missionActions.match(/sql<string>`id`\.as\("id"\)/g) ?? [];

  assert.equal(aliasedFields.length, 3);
  assert.doesNotMatch(
    missionActions,
    /db\.\$with\("mission_result_transition", \{ id: sql<string>`id` \}\)/,
  );
});
