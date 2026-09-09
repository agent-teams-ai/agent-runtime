import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const { createDarwinCodexHostPostClaimPreparation } = await import("../../../dist/features/contained-agent-turn/composition/darwin-codex-host-post-claim-preparation.js");
const { NodeProviderProcessCustodyCore } = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.js");
import { fixture, sessionDependencies, controlDarwinChildObservations } from "./darwin-native-finalization-fixture.ts";

// Preflight runs the emitted factory and actual nominal Host owner, with no
// installed observer and no listener/provider OS effect permitted.
test("emitted preparation refuses foreign owner and unavailable native artifact before allocation", async t => {
  const f = fixture(); const reserved = await f.reserve(); t.after(reserved.close);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {...platform, value: "darwin"});
  t.after(() => Object.defineProperty(process, "platform", platform));
  let launches = 0; controlDarwinChildObservations(() => {launches++; throw new Error("forbidden launch");});
  t.after(() => controlDarwinChildObservations());
  const host = new NodeProviderProcessCustodyCore({launchPlans: {resolve: async () => f.plan}}, {
    platform: "darwin", containmentProfile: "cooperative-darwin-posix-process-group", residueAuthorityFactory: {create: async () => {throw new Error("no allocation");}},
  });
  const limits = {deadline: 100, closureDeadline: 200, maxInboundHeaderBytes: 16000, maxInboundBodyBytes: 1024,
    maxUpstreamHeaderBytes: 16000, maxOutputBytes: 1024, maxBufferedBytes: 1024, maxUpstreamWireBytes: 20000};
  const base = {durableRoot: {path: "/absent-original-durable-root", dev: "1", ino: "2"}, boundary: f.boundary,
    executable: {path: f.options.executablePath, sha256: f.plan.executableSha256}, observer: {path: "/absent-native-observer", sha256: "a".repeat(64)},
    launcherSha256: "a".repeat(64), nodeSha256: "a".repeat(64), catalogSource: Buffer.alloc(0), tmpDir: f.options.tmpDir,
    limits, session: sessionDependencies(reserved), localCut: {operationDeadline: 100,
      expectedClock: {authorityId: "clock", epoch: "epoch"}, clock: {read: () => ({authorityId: "clock", epoch: "epoch", controlTime: 0}),
        within: async <T>(_deadline: number, operation: () => Promise<T>) => operation()}}};
  const claimed = {committedDispatchProof: reserved.lifetime.committedDispatchProof,
    signal: new AbortController().signal, underlyingCustodyRef: reserved.live.custodyRef};
  const foreign = createDarwinCodexHostPostClaimPreparation({...base, hostCustody: {}});
  assert.deepEqual(await foreign.prepareClaimed(claimed), {kind: "unsupported", reason: "owner"});
  const native = createDarwinCodexHostPostClaimPreparation({...base, hostCustody: host});
  assert.notEqual((await native.prepareClaimed(claimed)).kind, "prepared");
  assert.equal((await native.prepareClaimed(claimed)).kind, "quarantined");
  assert.equal(launches, 0);
});

test("native source/build protocol stays child-scoped and explicitly refuses a Linux build", () => {
  const root = new URL("../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native/", import.meta.url);
  const source = readFileSync(new URL("darwin-owned-image.c", root), "utf8");
  for (const token of ["PROC_PIDTBSDINFO", "PROC_PIDREGIONPATHINFO", "vst_ino", "vst_dev", "pbi_start_tvsec",
    "pbi_start_tvusec", "pbi_ppid", "pbi_pgid", "VM_PROT_EXECUTE", "same(&before, &after)", "getppid()", "count < 4096"]) {
    assert.ok(source.includes(token), token);
  }
  assert.equal(/proc_listpids|kill\s*\(/u.test(source), false);
  // Static source/protocol checks are not a Mac compiler/runtime assertion.
  if (process.platform === "linux") {
    const result = spawnSync(process.execPath, [new URL("build-darwin-owned-image.mjs", root).pathname,
      "/not-an-installed-compiler", "/tmp/ar69-never-built-observer"], {encoding: "utf8"});
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Usage on Darwin/u);
  }
});
