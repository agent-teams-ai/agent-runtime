import { workspacePackageSourceHref } from "../support/workspace-package-source.mjs";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {decodeBytes} from "./run-linux-codex-live-canary.mjs";
import {createContainedTurnSecurityAcceptancePort, NodeTlsHttpEgressTransport} from "@agent-teams/agent-execution/composition";
import {captureLinuxCodexDeploymentData} from "../../dist/composition/linux-codex-deployment-authority.js";
import {bindContainedTurnCapabilityAuthority} from "../../dist/composition/contained-turn-authority-capability.js";
const { NodeUnixSocketDockerEngine } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-composition.js"));
const { DockerEngineError } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-error.js"));
const { policy } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/docker-engine-test-fixture.ts"));
const { SYNTHETIC_LOOPBACK_CA } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "tests/fixtures/http-egress-tls/synthetic-loopback-certificates.ts"));
import {allocateLinuxCodexLiveAdminDirectories} from "./linux-codex-live-admin-directories.ts";
import {createLinuxCodexLiveCanaryConfiguration} from "./linux-codex-live-canary-config.ts";
const { containedTurnScopeDigest } = await import(workspacePackageSourceHref("@agent-teams/agent-execution", "dist/features/contained-agent-turn/domain/contained-turn-authority.js"));

// Constructor-only regression. Synthetic pins are not measured deployment facts;
// no setup, credentials, daemon observation, provider or network operations.
test("actual canary constructs RS acceptance port, Host access authority and engine while preserving guards",
  {skip: process.platform !== "linux" || process.arch !== "x64"}, async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "ar69-canary-engine-env-")));
    try {
      const {workspaceSourceRoot: _workspace, privateRootSourceRoot: _private,
        allowedEnvironmentKeys: _environment, cpuNanoCpus: _cpu, memoryBytes: _memory,
        pidsLimit: _pids, tmpfsBytes: _tmpfs, writableLayerBytes: _layer, ...enginePolicy} = policy(parent);
      const trustedCa = decodeBytes(JSON.parse(JSON.stringify({encoding: "base64",
        data: Buffer.from(SYNTHETIC_LOOPBACK_CA).toString("base64")})));
      assert.equal(Object.getPrototypeOf(trustedCa), Uint8Array.prototype);
      const approved = {
        approvedIntent: "write-one-marker-and-return-it/v1", testId: "engine-env",
        commandId: "command:engine-env", deploymentId: "deployment:synthetic",
        deploymentIncarnation: "incarnation:synthetic", markerFile: "marker.txt", marker: "synthetic",
        externalAuthorityDigest: `sha256:${"a".repeat(64)}`,
        binding: {accessRef: "access:synthetic", availability: "available", bindingRevision: 1,
          credentialBindingDigest: "credential:digest:synthetic", credentialBindingRef: "credential:synthetic",
          credentialGeneration: 1, projectId: "project:synthetic", provider: "codex",
          providerAccountRef: "account:synthetic", providerRouteRef: "route:synthetic", revocation: "active",
          scopeDigest: containedTurnScopeDigest({tenantId: "tenant:synthetic", projectId: "project:synthetic"}),
          tenantId: "tenant:synthetic"},
      } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[0];
      const pins = {
        sourceRevision: "b74acfc338655cc3731d0756f0c5d5d3c13108e6",
        hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
        testParent: parent, enginePolicy,
        tools: {nsenter: {path: join(parent, "nsenter"), sha256: "a".repeat(64)},
          nft: {path: join(parent, "nft"), sha256: "b".repeat(64)}},
        imageInitLock: {
          imageReference: "sha256:041d6401e155737c93b484483d16ccf460b66c41f1a71bbbeff259bf7a4d5a9a",
          imageConfigId: "sha256:041d6401e155737c93b484483d16ccf460b66c41f1a71bbbeff259bf7a4d5a9a", os: "linux", architecture: "amd64", variant: "",
          loadingPolicy: "closed-bundle-node-builtins-only-v1",
          interpreter: {path: "/ar-custody-node", mode: 0o555, size: 100,
            sha256: "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c"},
          bootstrap: {path: "/ar-custody-init.mjs", mode: 0o444, size: 85430,
            sha256: "e54bf7263a01b3ccc48a0b401a48eb14be60ce27520edd2bd865d04e3f04674c"},
        },
        native: {catalogSource: Buffer.from("{}"), ownerUid: 1000, ownerGid: 1000},
        observerSha256: "c".repeat(64), certificateAuthorities: [trustedCa],
      } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[1];
      for (const binding of [
        {...approved.binding, scopeDigest: "scope:synthetic"},
        {...approved.binding, scopeDigest: containedTurnScopeDigest({
          tenantId: approved.binding.tenantId, projectId: "project:other",
        })},
        {...approved.binding, tenantId: "tenant:other"},
      ]) {
        const mismatched = {...approved, binding};
        const retained = structuredClone(mismatched);
        // Invalid image pins would fail next: scope rejection must precede setup construction.
        assert.throws(() => createLinuxCodexLiveCanaryConfiguration(mismatched,
          {...pins, imageInitLock: {...pins.imageInitLock, imageReference: "invalid"}}),
        {name: "TypeError", message: "Approved Linux marker canary scope digest mismatch"});
        assert.deepEqual(mismatched, retained);
      }
      // The former image retains an inherited task label and is no longer approved.
      const labelledImage = "sha256:8db55f3551afd7c1032bb8dba936caefd4d5c8f2fb4b5f21af19da1fb7345979";
      assert.throws(() => createLinuxCodexLiveCanaryConfiguration(approved, {...pins,
        imageInitLock: {...pins.imageInitLock, imageReference: labelledImage, imageConfigId: labelledImage}}),
      {name: "TypeError", message: "Approved canary image/init closure mismatch"});
      const {approval, configuration} = createLinuxCodexLiveCanaryConfiguration(approved, pins);
      assert.deepEqual(approval.binding, approved.binding);
      assert.deepEqual(approval.dispatchPolicy.scope, {tenantId: approved.binding.tenantId,
        projectId: approved.binding.projectId, scopeDigest: approved.binding.scopeDigest});
      assert.equal(approval.intentAuthority.externalAuthorityDigest, approved.externalAuthorityDigest);
      const originalDigest = new NodeTlsHttpEgressTransport({...configuration.deployment.transport,
        certificateAuthorities: [trustedCa]}).tlsPolicyDigest;
      const snapshot = captureLinuxCodexDeploymentData(configuration.deployment.transport);
      assert.deepEqual(snapshot.certificateAuthorities, [SYNTHETIC_LOOPBACK_CA]);
      assert.ok(Object.isFrozen(configuration.deployment.transport.certificateAuthorities));
      assert.ok(Object.isFrozen(snapshot.certificateAuthorities));
      assert.equal(new NodeTlsHttpEgressTransport(snapshot).tlsPolicyDigest, originalDigest);
      assert.equal(approval.egressRule.tlsPolicyDigest, originalDigest);
      assert.throws(() => captureLinuxCodexDeploymentData({...snapshot, certificateAuthorities: [trustedCa]}),
        {name: "TypeError", message: "Linux Codex acknowledged deployment authority unavailable"});
      assert.throws(() => captureLinuxCodexDeploymentData({unsupported: new Uint8Array([1])}),
        {name: "TypeError", message: "Linux Codex acknowledged deployment authority unavailable"});
      for (const certificateAuthorities of [[], [new Uint8Array([0xff])],
        [Buffer.from("not a certificate")], ["not a certificate"],
        [Buffer.concat([Buffer.from(SYNTHETIC_LOOPBACK_CA), Buffer.from([0xff])])]]) {
        assert.throws(() => createLinuxCodexLiveCanaryConfiguration(approved, {...pins, certificateAuthorities}));
      }
      trustedCa.fill(0);
      assert.equal(new NodeTlsHttpEgressTransport(snapshot).tlsPolicyDigest, originalDigest);
      assert.deepEqual(configuration.deployment.transport.certificateAuthorities, [SYNTHETIC_LOOPBACK_CA]);
      const policyRevision = approval.dispatchPolicy.policyRevision;
      assert.match(policyRevision, /^security-authority:linux-codex-marker-canary:v1:[a-f0-9]{64}$/u);
      assert.equal(policyRevision.length, 112);
      assert.equal(approval.intentAuthority.authorityRevision, policyRevision);
      assert.equal(approval.egressRule.policyRef, policyRevision);
      assert.equal(approval.egressRule.revision, policyRevision);
      assert.deepEqual(await configuration.policy.read({
        scope: approval.dispatchPolicy.scope, providerId: approval.dispatchPolicy.providerId,
        intentDigest: approval.dispatchPolicy.intentDigest, policyRevision,
      }), approval.dispatchPolicy);
      assert.equal(configuration.authorityRevision,
        `runtime-access-authority:linux-codex-marker-canary-v1-${policyRevision.slice("security-authority:linux-codex-marker-canary:v1:".length)}`);
      assert.equal(configuration.authorityRevision.length, 118);
      let securityCalls = 0;
      const noSecurityIO = async () => {securityCalls += 1; throw new Error("Unexpected security owner invocation");};
      const securityOwner = Object.freeze({evaluateForAcceptance: noSecurityIO, publishAndConsumeForDispatch: noSecurityIO,
        observeDispatchConsumption: noSecurityIO, settleDispatchConsumption: noSecurityIO});
      // Same immutable profile selected by the live driver from dispatchPolicy.
      const security = createContainedTurnSecurityAcceptancePort(securityOwner, Object.freeze({policyRevision}));
      assert.equal(typeof security.authorizeForAcceptance, "function");
      assert.equal(typeof security.consumeForDispatch, "function");
      for (const invalidRevision of [policyRevision.slice("security-authority:".length),
        configuration.authorityRevision, `security-authority:${"a".repeat(512)}`,
        `${policyRevision}\n`, `${policyRevision}\u007f`]) {
        assert.throws(() => createContainedTurnSecurityAcceptancePort(securityOwner,
          Object.freeze({policyRevision: invalidRevision})),
        {name: "TypeError", message: "invalid trusted policy revision"});
      }
      assert.equal(securityCalls, 0);
      let featureCalls = 0;
      const execute = async () => {featureCalls += 1; throw new Error("Unexpected feature invocation");};
      const feature = {cancel: {execute}, observe: {execute}, submit: {execute}};
      const bound = bindContainedTurnCapabilityAuthority(feature, configuration.authorityRevision);
      assert.equal(bound.authorityRevision, configuration.authorityRevision);
      assert.throws(() => bindContainedTurnCapabilityAuthority(feature, policyRevision),
        {name: "TypeError", message: "Contained-turn access authority is invalid"});
      assert.equal(featureCalls, 0);
      const directories = await allocateLinuxCodexLiveAdminDirectories(configuration.testParent);
      const fullPolicy = {...configuration.node.enginePolicy, ...directories.engineRoots};
      let engineCalls = 0;
      const noEngineIO = () => {engineCalls += 1; throw new Error("Unexpected engine I/O");};
      const client = {buffered: noEngineIO, endpointIdentity: noEngineIO,
        stream: noEngineIO, hijack: noEngineIO};
      assert.deepEqual(fullPolicy.allowedEnvironmentKeys, ["AR_CUSTODY_INIT_CONFIGURATION"]);
      assert.ok(new NodeUnixSocketDockerEngine({policy: fullPolicy, client}) instanceof NodeUnixSocketDockerEngine);
      for (const key of ["DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_HOST", "HOME", "PATH", "TMPDIR"]) {
        assert.throws(() => new NodeUnixSocketDockerEngine({client,
          policy: {...fullPolicy, allowedEnvironmentKeys: [...fullPolicy.allowedEnvironmentKeys, key]}}),
        (error: unknown) => error instanceof DockerEngineError && error.code === "invalid-create-request", key);
      }
      for (const key of ["HOME", "PATH", "TMPDIR"]) {
        assert.ok(configuration.node.provider.allowedEnvironmentNames.includes(key));
      }
      assert.equal(engineCalls, 0);
    } finally {
      // No runtime owner received these directories.
      await rm(parent, {recursive: true, force: true});
    }
  });
