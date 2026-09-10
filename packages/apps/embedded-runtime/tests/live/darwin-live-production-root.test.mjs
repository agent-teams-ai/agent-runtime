import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {compileFunction} from "node:vm";
import test from "node:test";

// Execute the actual composition function with inert modules and a synthetic
// admitted process. Never acquire native descriptors, providers or a real Host.
const source = await readFile(new URL("./darwin-live-production-root.mjs", import.meta.url), "utf8");
const createRoot = compileFunction(`return ${source.slice(source.indexOf("export async function createDarwinLiveRuntime"))
  .replace("export async function", "async function").replaceAll("import(", "load(")}`,
["process", "load", "pathToFileURL", "refused"]);

function fixture({failPreparation = false} = {}) {
  const events = [];
  const native = {selection: {}, httpLaunchAuthority: {}, attemptAuthority: {}};
  const preparation = {}, operationStore = {}, dispatchAuthority = {dispatch: {}};
  const workspace = {}, artifacts = {dispose: async () => events.push("artifacts")};
  const nativeConsumers = () => {events.push("unexpected factory call"); throw new Error("only native capture may call the retained-owner factory");};
  const owned = {
    nativeConsumers, workspace: {}, artifacts: {}, deployment: {}, operationStore: {}, dispatchAuthority: {},
    providerAccess: {}, rendering: {}, pool: {}, host: {containedTurn: {existingPort: {}}},
    async createPostClaimPreparation(selection, httpLaunchAuthority) {
      assert.equal(selection, native.selection);
      assert.equal(httpLaunchAuthority, native.httpLaunchAuthority);
      if (failPreparation) {throw new Error("preparation refused");}
      return preparation;
    },
    dispose: async () => events.push("owners"), sealAdmission: async () => events.push("seal"),
    reconciliation: {retain: async result => {events.push("retain"); assert.equal(result.uncertainty, "unknown");}},
    cleanup: {recordFailure: error => {throw error;}, readback: () => "clean"},
  };
  const deployment = {
    routeEnforcement: {}, dispose: async () => events.push("deployment"),
    bindStore: value => {assert.equal(value, operationStore); return operationStore;},
    bindAuthority: value => {assert.equal(value, owned.dispatchAuthority); return dispatchAuthority;},
  };
  const host = {dispose: async () => events.push("host")};
  const modules = {
    "../../dist/composition.js": {
      bindDarwinNativeAttemptAuthority(store, authority) {
        assert.equal(store, owned.operationStore); assert.equal(authority, native.attemptAuthority); return operationStore;
      },
      createDarwinContainedTurnDeployment(input) {
        assert.equal(input.preparation, preparation);
        for (const key of ["providerAccess", "rendering", "pool"]) {assert.equal(input[key], owned[key]);}
        return deployment;
      },
      createHostCustodiedAgentRuntimeHost(input) {
        assert.equal(input.containedTurn.workspace, workspace);
        assert.equal(input.containedTurn.artifacts, artifacts);
        assert.equal(input.containedTurn.operationStore, operationStore);
        assert.equal(input.containedTurn.routeEnforcement, deployment.routeEnforcement);
        assert.equal(input.containedTurn.dispatch, dispatchAuthority.dispatch);
        assert.equal(input.containedTurn.existingPort, owned.host.containedTurn.existingPort);
        return host;
      },
    },
    "@agent-teams/agent-execution/composition": {
      captureRootDarwinAttemptWorkspace: async factory => {assert.equal(factory, nativeConsumers); return native;},
      createNodeContainedTurnWorkspaceOwner: async input => {
        assert.equal(input.selectedNativeWorkspace, native.selection);
        return {workspace, dispose: async () => events.push("workspace")};
      },
      createNodeContainedTurnArtifacts: async input => {assert.equal(input.workspaceOwner.workspace, workspace); return artifacts;},
    },
    "file:///inert-owners.mjs": {acquireDarwinLiveOwners: async () => owned},
  };
  const run = createRoot({platform: "darwin", arch: "arm64", getuid: () => 501,
    argv: ["node", "inert", "--darwin-attempt-owner-bridge"]},
  async specifier => {assert.ok(Object.hasOwn(modules, specifier)); return modules[specifier];},
  path => new URL(`file://${path}`), () => new Error("refused"));
  return {run: () => run({runtimeRootModulePath: "/inert-owners.mjs"}), events, host};
}

test("native factory and both preparation authorities reach the public Host composition", async () => {
  const value = fixture();
  const runtime = await value.run();
  assert.equal(runtime.host, value.host);
  assert.equal(await runtime.dispose({uncertainty: "unknown"}), "clean");
  assert.equal(await runtime.dispose(), "clean");
  assert.deepEqual(value.events, ["seal", "retain", "host", "deployment", "artifacts", "workspace", "owners"]);
});

test("preparation failure seals admission and releases the acquired owners in reverse order", async () => {
  const value = fixture({failPreparation: true});
  await assert.rejects(value.run(), /preparation refused/);
  assert.deepEqual(value.events, ["seal", "artifacts", "workspace", "owners"]);
});
