import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const missionActions = readFileSync(new URL("../app/actions/missions.ts", import.meta.url), "utf8");

test("every mission result transition keeps its updating CTE at the top level", () => {
  const topLevelTransitions = missionActions.match(/transitionQuery = db\.execute<\{ id: string \}>\(sql`/g) ?? [];

  assert.equal(topLevelTransitions.length, 3);
  assert.doesNotMatch(missionActions, /\$with\("mission_result_transition"/);
  assert.match(missionActions, /databaseErrorCode\(error\)/);
});
