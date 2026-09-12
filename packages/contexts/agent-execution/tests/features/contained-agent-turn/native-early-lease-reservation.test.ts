import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import test from "node:test";
import * as synthetic from "./synthetic-native-custody-producer.fixture.ts";

const producer = new URL("./synthetic-native-custody-producer.fixture.ts", import.meta.url).href;
registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith("/darwin-attempt-owner-selection.js") &&
      context.parentURL?.endsWith("/native-host-custody-workspace-authority.ts")) {
    return {url: producer, shortCircuit: true};
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    return {url: new URL(specifier.slice(0, -3) + ".ts", context.parentURL).href, shortCircuit: true};
  }
  return next(specifier, context);
}});

const authority = await import("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-authority.ts");
const ids = {operationId: "synthetic-operation", attemptId: "synthetic-attempt", workspaceId: "synthetic-workspace"};

test("workspace custody reserves before claim and awaits unused lease settlement", async () => {
  const selection = synthetic.issueSyntheticSelection(); let grant!: Parameters<typeof authority.retireNativeHostCustodyWorkspaceAuthority>[0];
  await assert.rejects(authority.withNativeHostCustodyWorkspaceAuthority(selection as never, ids, async value => {
    grant = value; assert.equal(synthetic.inspectSyntheticSelectionState(selection).reserved, true);
    throw new Error("pre-claim failure");
  }), /pre-claim failure/u);
  const state = synthetic.inspectSyntheticSelectionState(selection);
  assert.equal(state.cutoff, true); assert.equal(state.routeSettled, true);
  assert.equal(state.materialSettled, true); assert.equal(state.disposed, true);
  assert.throws(() => authority.inspectNativeHostCustodyExecutionLease(grant), /unavailable/u);
});
