import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireContainedTurnLiveCanaryAuthorities } from "../../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-turn-live-canary-lifecycle.mjs";
import {
  createHostCustodiedContainedTurn, ProviderRouteEnforcementUnsupportedError,
} from "../dist/composition/contained-turn-feature-composition.js";

test("exact current provider candidates are absent from the qualification registry", async () => {
  const registry = JSON.parse(await readFile(new URL(
    "../../../../docs/architecture/qualification-registry.json", import.meta.url,
  ), "utf8")) as {entries: readonly unknown[]};
  const serialized = JSON.stringify(registry.entries);
  assert.doesNotMatch(serialized, /0\.150\.1/u);
  assert.doesNotMatch(serialized, /0\.3\.251/u);
  assert.doesNotMatch(serialized, /codex-app-server-current-kernel/u);
  assert.doesNotMatch(serialized, /claude-agent-sdk-current-kernel/u);
});

test("the provider route gate does not alter the exact seven composition ports", async () => {
  const composition = await readFile(new URL(
    "../src/composition/contained-turn-feature-composition.ts", import.meta.url,
  ), "utf8");
  const supplied = [...composition.matchAll(
    /^    (operationStore|security|providerAccess|workspace|artifacts|custody|provider)(?=:|,$)/gmu,
  )].map(match => match[1]);
  assert.deepEqual(supplied, [
    "operationStore", "security", "providerAccess", "workspace", "artifacts", "custody", "provider",
  ]);
  const qualification = await readFile(new URL(
    "../src/composition/contained-turn-route-qualification.ts", import.meta.url,
  ), "utf8");
  for (const source of [composition, qualification]) {
    assert.doesNotMatch(source, /networkGateway|networkRoutePort/u);
  }
  const publicComposition = await readFile(new URL("../src/composition.ts", import.meta.url), "utf8");
  assert.doesNotMatch(publicComposition,
    /composeCandidateHostCustodied|composeHostCustodiedContainedTurn|composeQualifiedHostCustodied/u);
});

test("the product entrypoint still refuses today, and refuses for a registry reason", async () => {
  // The gate is conditional, but this checkout promotes no enforced route, so
  // the exact same construction refusal is still the only product outcome.
  assert.throws(() => createHostCustodiedContainedTurn(Object.freeze({
    artifacts: Object.freeze({}), hostCustody: Object.freeze({}), operationStore: Object.freeze({}),
    providerAccess: Object.freeze({}), routeEnforcement: Object.freeze({admission: Object.freeze({})}),
    security: Object.freeze({}), selectedProvider: Object.freeze({kind: "codex", owner: Object.freeze({})}),
    workspace: Object.freeze({}),
  }) as never), (error: unknown) => error instanceof ProviderRouteEnforcementUnsupportedError &&
    error.reason === "route-enforcement-unqualified");
  const registry = JSON.parse(await readFile(new URL(
    "../../../../docs/architecture/qualification-registry.json", import.meta.url,
  ), "utf8")) as {entries: readonly {qualification: string}[]};
  assert.equal(registry.entries.every(entry => entry.qualification === "scoped"), true);
  const readiness = await readFile(new URL(
    "../../../../docs/architecture/readiness.md", import.meta.url,
  ), "utf8");
  assert.match(readiness, /route-enforcement-unqualified/u);
});

test("real canary route authority rejects caller-shaped grants before any provider construction", () => {
  let calls = 0;
  const caller = new Proxy({}, {get() {calls += 1; throw new Error("must never consult caller authority");}});
  assert.throws(() => Reflect.apply(requireContainedTurnLiveCanaryAuthorities, undefined, [caller]),
    (error: unknown) => error instanceof Error && error.message === "route-enforcement-unqualified");
  assert.equal(calls, 0);
});
