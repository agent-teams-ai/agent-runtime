import assert from "node:assert/strict";
import test from "node:test";

import { inputFor } from "./dispatch-consumption-test-fixture.ts";

test("Route C contract contains no secret, raw path, home, environment, SDK, Agent Execution, or Module Kit fields", async () => {
  const input = await inputFor();
  const text = JSON.stringify(input).toLowerCase();
  for (const token of ["secret", "path", "home", "environment", "sdk", "appserver", "acp", "agentexecution", "modulekit"]) {
    assert.equal(text.includes(token), false);
  }
});
