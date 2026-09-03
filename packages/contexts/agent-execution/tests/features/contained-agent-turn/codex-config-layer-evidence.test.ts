import assert from "node:assert/strict";
import { test } from "node:test";
import { boundary, exactConfigResult } from "../../codex-app-server-contained-turn-provider-fixture.ts";
import { validateCodexConfigEvidence } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";

type Layer = {config: Record<string, unknown>; disabledReason?: unknown;
  name: Record<string, unknown>; version: string};
const layersOf = (config: ReturnType<typeof exactConfigResult>) => config.layers as Layer[];

test("accepts omitted or null disabledReason from the exact 0.150.1 config wire", () => {
  for (const omitted of [true, false]) {
    const config = exactConfigResult();
    for (const layer of layersOf(config)) {
      if (omitted) {delete layer.disabledReason;} else {layer.disabledReason = null;}
    }
    validateCodexConfigEvidence(config, boundary);
  }
});

test("admits only an empty exact system placeholder, never a system policy or duplicate layer", () => {
  const config = exactConfigResult();
  const [system, ...remaining] = layersOf(config);
  assert.ok(system);
  for (const replacement of [
    {...system, config: {model: "unqualified-system-policy"}},
    {...system, config: {permissions: {}}},
    {...system, name: {type: "system", file: "/other/config.toml"}},
    {...system, extra: true},
  ]) {
    assert.throws(() => validateCodexConfigEvidence({...config, layers: [replacement, ...remaining]}, boundary), /rejected/u);
  }
  assert.throws(() => validateCodexConfigEvidence({...config, layers: [system, system, ...remaining]}, boundary), /rejected/u);
  assert.throws(() => validateCodexConfigEvidence({...config, layers: remaining}, boundary), /rejected/u);
});

test("does not treat disabled or malformed config layers as active policy evidence", () => {
  for (const disabledReason of ["disabled by policy", undefined, false, {}, 1]) {
    for (let index = 0; index < 3; index += 1) {
      const config = exactConfigResult();
      layersOf(config)[index]!.disabledReason = disabledReason;
      assert.throws(() => validateCodexConfigEvidence(config, boundary), /rejected/u);
    }
  }
});
