import assert from "node:assert/strict";
import test from "node:test";

import {
  createSanitizedEnvironment,
  inheritedSensitiveKeys,
} from "../src/features/scenario-execution/sanitized-environment.ts";
import type { ScenarioSandbox } from "../src/features/scenario-execution/scenario.ts";

const sandbox: ScenarioSandbox = {
  root: "/sandbox",
  home: "/sandbox/home",
  workspace: "/sandbox/workspace",
  temp: "/sandbox/tmp",
  xdgConfig: "/sandbox/home/.config",
  xdgData: "/sandbox/home/.local/share",
  xdgState: "/sandbox/home/.local/state",
  xdgCache: "/sandbox/home/.cache",
  codexHome: "/sandbox/home/.codex",
  claudeConfig: "/sandbox/home/.claude",
};

test("does not inherit ambient credentials", () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  try {
    const environment = createSanitizedEnvironment(sandbox);
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(inheritedSensitiveKeys(environment), []);
    assert.equal(environment.HOME, sandbox.home);
    assert.equal(environment.CODEX_HOME, sandbox.codexHome);
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }
  }
});

test("rejects credential-shaped overrides", () => {
  assert.throws(
    () =>
      createSanitizedEnvironment(sandbox, {
        PROVIDER_TOKEN: "fixture",
      }),
    /requires an explicit credential fixture/,
  );
});
