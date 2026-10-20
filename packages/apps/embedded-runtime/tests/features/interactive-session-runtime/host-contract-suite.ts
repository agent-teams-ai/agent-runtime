import assert from "node:assert/strict";
import {declareModule} from "@get-modular/assembly";
import {contractSuite, isolate, runContractSuite, type TestFn} from "@get-modular/conformance";
import type {InteractiveSessionHost, InteractiveSessionApi} from "../../../dist/features/interactive-session-runtime/contracts/interactive-session-host.js";
import {Host} from "../../../dist/features/interactive-session-runtime/composition/interactive-session-runtime.contracts.js";
import {hostModule} from "../../../dist/features/interactive-session-runtime/composition/host.module.js";
import {fixture, ref} from "./support.ts";

/** The contract owner's reusable development suite; production never imports this entry. */
export const hostContractSuite = contractSuite(Host, {
  "foreign scope refusal preserves the valid scoped capability": host => {
    assert.throws(() => host.bindAccess({...ref, projectId: "TEST-other-project"}));
    assert.equal(typeof host.bindAccess(ref).open, "function");
  },
  "a new session has no manufactured durable state": async host => {
    assert.equal(await host.bindAccess(ref).read(ref), undefined);
  },
  "repeatable disposal cuts off fresh caller authority": async host => {
    await host.dispose(); await host.dispose(); assert.throws(() => host.bindAccess(ref));
  },
});

const fakeDeclaration = declareModule({moduleId: "agent-runtime/interactive-host/host",
  implementationId: "agent-runtime/interactive-host/host/test-fake", owner: {authority: "agent-runtime", path: ["interactive-session-runtime"]},
  provides: [Host.provide()], slots: []});
const unavailable = async () => ({status: "unavailable" as const});
const fakeHost = (): InteractiveSessionHost => {
  let disposed = false;
  const api: InteractiveSessionApi = {open: unavailable, read: async () => {}, submit: unavailable,
    reply: unavailable, interrupt: unavailable, close: unavailable, restore: unavailable};
  return {bindAccess: scope => {
    if (disposed || scope.tenantId !== ref.tenantId || scope.projectId !== ref.projectId) {throw new Error("TEST-scope-denied");}
    return api;
  }, control: {dispatch: unavailable, pumpOutput: unavailable, recover: unavailable, checkpoint: unavailable}, dispose: async () => {disposed = true;}};
};
export function registerHostContractSuite(test: TestFn): void {
  runContractSuite(hostContractSuite, {name: "actual scoped Host module", declaration: hostModule.declaration,
    create: async context => {
      const f = fixture(); const built = await isolate(hostModule, {dependencies: {...f.ports, ownership: f.ownership}, within: context.resources});
      return built.instance;
    }}, test);
  runContractSuite(hostContractSuite, {name: "independent owner fake", declaration: fakeDeclaration, create: fakeHost}, test);
}
