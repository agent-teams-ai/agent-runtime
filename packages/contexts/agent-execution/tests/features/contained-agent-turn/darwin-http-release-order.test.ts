import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {test} from "node:test";

test("native settlement waits for successful cutoff and route cleanup, then retries", () => {
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {mock} from "node:test";
    const root = ${JSON.stringify(new URL("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/", import.meta.url).href)};
    const original = await import(root + "darwin-attempt-owner-selection.js");
    let failure, calls = [];
    mock.module(root + "darwin-attempt-owner-selection.js", {namedExports: {...original,
      cutoffDarwinNativeExecution: async () => {calls.push("cutoff"); if (failure === "cutoff") throw Error("cutoff");},
      settleDarwinNativeExecutionLaunchRoute: async () => {calls.push("route");},
      settleDarwinNativeExecutionPrivateMaterial: async () => {calls.push("private");},
      disposeDarwinNativeExecution: async () => {calls.push("dispose");},
    }});
    const {NodeCustodyHttpResources} = await import(root + "node-custody-http-resources.js");
    mock.method(NodeCustodyHttpResources.prototype, "cleanup", async () => {
      if (failure === "throw") throw Error("route");
      return failure !== "false";
    });
    const {NodeProviderProcessCustodyHttpReservation} = await import(root + "node-provider-process-custody-http-reservation.js");
    for (const fault of ["cutoff", "throw", "false"]) {
      failure = fault; calls = [];
      const reservation = new NodeProviderProcessCustodyHttpReservation();
      reservation.retainNativeExecution(Object.freeze({}));
      assert.equal(await reservation.cleanup(), false);
      assert.deepEqual(calls, ["cutoff"]);
      failure = undefined;
      assert.equal(await reservation.cleanup(), true);
      assert.deepEqual(calls, fault === "cutoff" ? ["cutoff", "cutoff", "route", "private", "dispose"] : ["cutoff", "route", "private", "dispose"]);
      assert.equal(await reservation.cleanup(), true);
      assert.equal(calls.filter(call => call === "dispose").length, 1);
    }
  `], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
