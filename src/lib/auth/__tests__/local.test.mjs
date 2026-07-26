import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { getLocalMissionControlUser, isLocalAuthDisabled } from "../local.ts";

const originalValue = process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;
const flagName = "MISSION_CONTROL_LOCAL_AUTH_DISABLED";

function setFlag(value) {
  Object.assign(process.env, { [flagName]: value });
}

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;
  } else {
    setFlag(originalValue);
  }
});

describe("local Mission Control auth", () => {
  test("fails closed when the flag is absent", () => {
    delete process.env.MISSION_CONTROL_LOCAL_AUTH_DISABLED;

    assert.equal(isLocalAuthDisabled(), false);
    assert.equal(getLocalMissionControlUser(), null);
  });

  test("only disables auth for the exact value true", () => {
    for (const value of ["false", "TRUE", "1", "yes", " true "]) {
      setFlag(value);
      assert.equal(isLocalAuthDisabled(), false, value);
      assert.equal(getLocalMissionControlUser(), null, value);
    }

    setFlag("true");
    assert.equal(isLocalAuthDisabled(), true);
    assert.deepEqual(getLocalMissionControlUser(), { email: "local@mission-control" });
  });
});
