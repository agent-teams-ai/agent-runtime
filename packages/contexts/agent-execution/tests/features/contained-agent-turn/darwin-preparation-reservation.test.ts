import assert from "node:assert/strict";
import {test, after} from "node:test";
import {fixture, directory, file, retainedBytes, sessionDependencies, syntheticNodeModule,
  enablePreparationOS, preparationEffects, mutate} from "./darwin-native-finalization-fixture.ts";

const {NodeProviderProcessCustodyCore} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.js");
const {NodeProviderProcessCustodyHttpReservation} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-http-reservation.js");
const {createDarwinCodexHostPostClaimPreparation} = await import("../../../dist/features/contained-agent-turn/composition/darwin-codex-host-post-claim-preparation.js");
const {darwinDigest} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-route-durable-storage.js");
const {DarwinSeatbeltRouteOwner} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/darwin-seatbelt-route-owner.js");
const {nativeHttpRequestProfile} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/native-http-request-profile.js");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", {...platform, value: "darwin"});
after(() => Object.defineProperty(process, "platform", platform));
enablePreparationOS();
const native = process.dlopen;
const locked = new Set<number>();
process.dlopen = (module, path) => {
  assert.equal(path, new URL("../../../../../platform/filesystem-custody/dist/rename-no-replace.node", import.meta.url).pathname);
  module.exports = {tryLockDirectory(fd: number) {assert.equal(locked.has(fd), false); locked.add(fd); return true;},
    unlockDirectory(fd: number) {assert.equal(locked.delete(fd), true);}};
};
after(() => {process.dlopen = native; assert.equal(locked.size, 0);});

// All product owners execute from this workspace's emitted packages. Only the
// OS (filesystem, native lock and net.Server) is synthetic; no provider starts.
test("outer preparation binds actual reserved TMPDIR before allocation and at final binding", async t => {
  for (const mode of ["positive", "foreign", "home", "workspace", "replacement-before", "replacement-final"] as const) {
    const f = fixture("analysis", true); const reference = await f.reserve();
    const profile = nativeHttpRequestProfile("codex-chatgpt-responses/v1")!;
    const session = {...sessionDependencies(reference), route: Object.freeze({requestProfile: profile.id,
      routeReceiptDigest: "synthetic-route", originHost: profile.originHost, originPort: profile.originPort,
      upstreamMethod: profile.upstreamMethod, upstreamPath: profile.upstreamPath,
      forwardedRequestHeaderNames: profile.forwardedRequestHeaderNames, credentialFieldNames: profile.credentialFieldNames})}; const proof = reference.lifetime.committedDispatchProof; reference.close();
    const owner = new NodeProviderProcessCustodyCore({launchPlans: {resolve: async () => f.plan},
      residueAuthorityFactory: {create: async () => ({attachGuardian: async () => false, close: async () => false,
        killAll: async () => false, proveEmpty: async () => "unproven" as const})}},
      {platform: "darwin", containmentProfile: "cooperative-darwin-posix-process-group",
        residueAuthorityFactory: {create: async () => {throw new Error("unused");}}});
    const reserved = await owner.reserve({...f.input, launchPlan: f.plan, workspaceAuthority: f.workspaceAuthority()});
    let live: Parameters<NodeProviderProcessCustodyHttpReservation["acquire"]>[0] | undefined;
    const acquire = NodeProviderProcessCustodyHttpReservation.prototype.acquire;
    const capture = t.mock.method(NodeProviderProcessCustodyHttpReservation.prototype, "acquire", function (...args) {
      live = args[0]; return acquire.apply(this, args);
    });
    for (const path of ["/System/Library", "/usr/lib", "/usr/bin", "/owned", "/durable", "/foreign/tmp",
      process.execPath.slice(0, process.execPath.lastIndexOf("/"))]) {directory(path);}
    for (const path of ["/owned/observer", "/usr/bin/sandbox-exec", process.execPath]) {file(path, Buffer.from("pinned tool"), 0o100700);}
    const fs = syntheticNodeModule("node:fs") as typeof import("node:fs");
    const s = fs.lstatSync("/durable");
    const tmpDir = mode === "foreign" ? "/foreign/tmp" : mode === "home" ? f.boundary.codexHome
      : mode === "workspace" ? f.boundary.workspaceRef : f.options.tmpDir;
    const input = {hostCustody: owner, durableRoot: {path: "/durable", dev: String(s.dev), ino: String(s.ino)},
      boundary: f.boundary, executable: {path: f.options.executablePath, sha256: f.plan.executableSha256},
      observer: {path: "/owned/observer", sha256: darwinDigest("pinned tool")},
      launcherSha256: darwinDigest("pinned tool"), nodeSha256: darwinDigest("pinned tool"),
      catalogSource: retainedBytes("models.json"), tmpDir, session,
      limits: {deadline: 100, closureDeadline: 200, maxInboundHeaderBytes: 16000, maxInboundBodyBytes: 1024,
        maxUpstreamHeaderBytes: 16000, maxOutputBytes: 1024, maxBufferedBytes: 1024, maxUpstreamWireBytes: 20000},
      localCut: {operationDeadline: 100, expectedClock: {authorityId: "clock", epoch: "epoch"},
        clock: {read: () => ({authorityId: "clock", epoch: "epoch", controlTime: 0}),
          within: async <T>(_deadline: number, operation: () => Promise<T>) => operation()}}};
    const before = preparationEffects.length;
    if (mode === "replacement-before") {mutate(tmpDir, {ino: 900001});}
    const originalBind = DarwinSeatbeltRouteOwner.prototype.bindFinal;
    const binding = t.mock.method(DarwinSeatbeltRouteOwner.prototype, "bindFinal", function (final) {
      if (mode === "replacement-final") {mutate(tmpDir, {ino: 900002});}
      return originalBind.call(this, final);
    });
    const result = await createDarwinCodexHostPostClaimPreparation(input).prepareClaimed({
      committedDispatchProof: proof, signal: new AbortController().signal, underlyingCustodyRef: reserved.custodyRef});
    capture.mock.restore(); binding.mock.restore();
    assert.ok(live, "factory must acquire the actual Host reservation");
    try {
      if (mode === "positive") {
        assert.deepEqual(result, {kind: "prepared"});
        const final = NodeProviderProcessCustodyCore.launchView(owner, reserved.custodyRef)!.readFinal();
        assert.equal(final.plan.environment.TMPDIR, tmpDir);
        assert.deepEqual(live.httpReservation.darwinRoute!.projection.writePaths, [tmpDir]);
        assert.equal(live.httpReservation.darwinRoute!.state, "launch-authorized");
        assert.ok(preparationEffects.slice(before).includes("listen"));
      } else {
        assert.equal(result.kind, "quarantined", mode);
        assert.throws(() => NodeProviderProcessCustodyCore.launchView(owner, reserved.custodyRef)!.readFinal());
        if (mode !== "replacement-final") {
          assert.equal(preparationEffects.slice(before).some(effect => effect === "listen" || effect.startsWith("create:")), false, mode);
        }
      }
    } finally {
      const cleaned = await live.httpReservation.cleanup();
      if (mode === "positive") {
        assert.equal(cleaned, true);
        const effects = preparationEffects.slice(before);
        assert.ok(effects.includes("listener-close"));
        assert.ok(effects.includes(`unlink:${f.boundary.codexHome}/config.toml`));
        assert.ok(effects.includes(`unlink:${f.boundary.codexHome}/models.json`));
      }
      live.launchAuthority?.close(); live.retainedWorkspaceAuthority?.close(); live.privateRootCleanupAuthority?.close();
    }
  }
});
