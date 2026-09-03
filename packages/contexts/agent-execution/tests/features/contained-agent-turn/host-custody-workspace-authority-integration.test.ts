import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { NodeProviderProcessCustody } from "../../../dist/composition.js";
import { createClaudeAgentSdkPrivateProjection } from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { privateHostCustodyReservationTestSupport } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/private-host-custody-reservation.js";

test("raw Host reservation rejects a replaced filesystem descriptor before launch effects", {
  skip: process.platform === "linux" ? false : "descriptor-bound production Host Custody is Linux-only",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-handoff-")));
  try {
    const expected = join(root, "expected");
    const replacement = join(root, "replacement");
    await Promise.all([mkdir(expected, { mode: 0o700 }), mkdir(replacement, { mode: 0o700 })]);
    const expectedIdentity = await stat(expected, { bigint: true });
    const replacementHandle = await open(replacement, "r");
    try {
      const host = new NodeProviderProcessCustody({launchPlans: {resolve: async () => {}}});
      await assert.rejects(host.reserve({
        attemptId: "attempt:handoff", intentMode: "analysis",
        launchPlan: Object.freeze({
          arguments: Object.freeze([]), binaryRevision: "binary:test",
          containmentProfile: "strict-linux-cgroup-v2", environment: Object.freeze({HOME: "/invalid"}),
          executablePath: "/invalid", executableSha256: "0".repeat(64), intentMode: "analysis",
          privateRootPath: "/invalid-private", provider: "codex", spawnMode: "sdk-delegated",
        }),
        operationId: "operation:handoff",
        providerBinding: Object.freeze({
          adapterRevision: "adapter:test", binaryRevision: "binary:test",
          capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
          provider: "codex", providerRouteRef: "route:test",
        }),
        workspaceAuthority: Object.freeze({
          canonicalPath: expected, descriptorPath: `/proc/self/fd/${replacementHandle.fd}`,
          identity: Object.freeze({dev: expectedIdentity.dev, ino: expectedIdentity.ino, mountId: "mount:test"}),
        }),
        workspaceRef: expected,
      }), /workspace descriptor identity mismatch/u);
    } finally {await replacementHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test("raw Host reservation rejects exact path, device and inode on a substituted mount before provider effect", {
  skip: process.platform === "linux" ? false : "descriptor-bound production Host Custody is Linux-only",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-mount-identity-")));
  try {
    const workspaceRef = join(root, "workspace");
    const privateRootPath = `${workspaceRef}-host-private`;
    const configRoot = join(privateRootPath, "config");
    const homeRoot = join(privateRootPath, "home");
    const temp = join(privateRootPath, "temp");
    await Promise.all([mkdir(workspaceRef, {mode: 0o700}), mkdir(privateRootPath, {mode: 0o700})]);
    await Promise.all([mkdir(configRoot, {mode: 0o700}), mkdir(homeRoot, {mode: 0o700}), mkdir(temp, {mode: 0o700})]);
    const authorityHandle = await open(workspaceRef, "r");
    try {
      const identity = await authorityHandle.stat({bigint: true});
      const fdinfo = await readFile(`/proc/self/fdinfo/${authorityHandle.fd}`, "utf8");
      const mountId = /^mnt_id:\s*(\d+)$/mu.exec(fdinfo)?.[1];
      assert.ok(mountId);
      const projection = createClaudeAgentSdkPrivateProjection({
        configRoot, homeRoot, projectionRef: "projection:mount-substitution", tempRoot: temp, workspaceRef,
      });
      const plan = Object.freeze({
        arguments: Object.freeze([]), binaryRevision: "binary:synthetic-host-mount-test",
        containmentProfile: "strict-linux-cgroup-v2" as const, environment: projection.environment,
        executablePath: process.execPath,
        executableSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
        intentMode: "analysis" as const, privateRootPath,
        provider: "claude" as const, spawnMode: "sdk-delegated" as const,
      });
      const effects = {descriptorCloses: 0, guardianAuthorizations: 0, providerStarts: 0};
      const host = new NodeProviderProcessCustody({
        launchPlans: {resolve: async () => {}},
        residueAuthorityFactory: Object.freeze({async create() {return Object.freeze({
          async attachGuardian() {effects.guardianAuthorizations += 1; return true;},
          async close() {return true;}, async killAll() {return true;}, async proveEmpty() {return "empty" as const;},
        });}}),
      });
      privateHostCustodyReservationTestSupport.install(host, {
        descriptorLifecycle: event => {if (event === "closed") {effects.descriptorCloses += 1;}},
        mountIdentity: observation => observation.phase === "launch"
          ? `${observation.actualMountId}:substituted`
          : observation.actualMountId,
      });
      const reservation = await host.reserve({
        attemptId: "attempt:mount-substitution", intentMode: "analysis",
        launchPlan: plan,
        operationId: "operation:mount-substitution",
        providerBinding: Object.freeze({
          adapterRevision: "adapter:synthetic-host-mount-test", binaryRevision: plan.binaryRevision,
          capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
          provider: "claude", providerRouteRef: "route:test",
        }),
        workspaceAuthority: Object.freeze({
          canonicalPath: workspaceRef, descriptorPath: `/proc/self/fd/${authorityHandle.fd}`,
          identity: Object.freeze({dev: identity.dev, ino: identity.ino, mountId}),
        }),
        workspaceRef,
      });
      assert.equal(host.get(reservation.custodyRef), undefined);
      assert.throws(() => host.start(reservation.custodyRef, {
        arguments: plan.arguments, command: plan.executablePath, cwd: "/proc/self/fd/4",
        environment: plan.environment, signal: new AbortController().signal,
      }), {name: "HostCustodyLaunchRejectedError"});
      effects.providerStarts += host.get(reservation.custodyRef) === undefined ? 0 : 1;
      assert.deepEqual(effects, {descriptorCloses: 1, guardianAuthorizations: 0, providerStarts: 0});
      assert.equal(host.evidence(reservation.custodyRef)?.spawn, "never-started");
    } finally {await authorityHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});

test("throwing reserved-plan getters and reservation validation close retained authority exactly once", {
  skip: process.platform === "linux" ? false : "descriptor-bound production Host Custody is Linux-only",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-reservation-exception-")));
  try {
    const workspaceRef = join(root, "workspace");
    await mkdir(workspaceRef, {mode: 0o700});
    const authorityHandle = await open(workspaceRef, "r");
    try {
      const identity = await authorityHandle.stat({bigint: true});
      const fdinfo = await readFile(`/proc/self/fdinfo/${authorityHandle.fd}`, "utf8");
      const mountId = /^mnt_id:\s*(\d+)$/mu.exec(fdinfo)?.[1];
      assert.ok(mountId);
      for (const failureKind of ["plan-getter", "mount-validation"] as const) {
        const closes: string[] = [];
        const host = new NodeProviderProcessCustody({launchPlans: {resolve: async () => {}}});
        privateHostCustodyReservationTestSupport.install(host, {
          descriptorLifecycle: event => {if (event === "closed") {closes.push(event);}},
          ...(failureKind === "mount-validation" ? {
            mountIdentity: ({actualMountId}: {actualMountId: string}) => `${actualMountId}:invalid`,
          } : {}),
        });
        const planFailure = new Error("synthetic throwing plan getter");
        const launchPlan = failureKind === "plan-getter"
          ? Object.defineProperty({}, "arguments", {enumerable: true, get() {throw planFailure;}})
          : Object.freeze({arguments: Object.freeze([]), environment: Object.freeze({})});
        await assert.rejects(host.reserve({
          attemptId: `attempt:${failureKind}`, intentMode: "analysis", launchPlan: launchPlan as never,
          operationId: `operation:${failureKind}`,
          providerBinding: Object.freeze({
            adapterRevision: "adapter:test", binaryRevision: "binary:test",
            capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test",
            provider: "codex", providerRouteRef: "route:test",
          }),
          workspaceAuthority: Object.freeze({
            canonicalPath: workspaceRef, descriptorPath: `/proc/self/fd/${authorityHandle.fd}`,
            identity: Object.freeze({dev: identity.dev, ino: identity.ino, mountId}),
          }), workspaceRef,
        }), error => failureKind === "plan-getter" ? error === planFailure : error instanceof TypeError);
        assert.deepEqual(closes, ["closed"]);
      }
    } finally {await authorityHandle.close();}
  } finally {await rm(root, {recursive: true, force: true});}
});
