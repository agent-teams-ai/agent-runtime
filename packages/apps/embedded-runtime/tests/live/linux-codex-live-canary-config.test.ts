import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {decodeBytes} from "./run-linux-codex-live-canary.mjs";
import {NodeTlsHttpEgressTransport} from "../../../../contexts/agent-execution/dist/composition.js";
import {captureLinuxCodexDeploymentData} from "../../dist/composition/linux-codex-deployment-authority.js";
import {bindContainedTurnCapabilityAuthority} from "../../dist/composition/contained-turn-authority-capability.js";
import {NodeUnixSocketDockerEngine} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-composition.js";
import {DockerEngineError} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-error.js";
import {policy} from "../../../../contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts";
import {SYNTHETIC_LOOPBACK_CA} from
  "../../../../contexts/agent-execution/tests/fixtures/http-egress-tls/synthetic-loopback-certificates.ts";
import {allocateLinuxCodexLiveAdminDirectories} from "./linux-codex-live-admin-directories.ts";
import {createLinuxCodexLiveCanaryConfiguration} from "./linux-codex-live-canary-config.ts";

// Constructor-only regression. Synthetic pins are not measured deployment facts;
// no setup, credentials, daemon observation, provider or network operations.
test("actual canary constructs Host access authority and engine while preserving RS policy and environment guards",
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
          scopeDigest: "scope:synthetic", tenantId: "tenant:synthetic"},
      } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[0];
      const pins = {
        sourceRevision: "b74acfc338655cc3731d0756f0c5d5d3c13108e6",
        hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
        testParent: parent, enginePolicy,
        tools: {nsenter: {path: join(parent, "nsenter"), sha256: "a".repeat(64)},
          nft: {path: join(parent, "nft"), sha256: "b".repeat(64)}},
        imageInitLock: {
          imageReference: "sha256:8db55f3551afd7c1032bb8dba936caefd4d5c8f2fb4b5f21af19da1fb7345979",
          imageConfigId: "sha256:8db55f3551afd7c1032bb8dba936caefd4d5c8f2fb4b5f21af19da1fb7345979", os: "linux", architecture: "amd64", variant: "",
          loadingPolicy: "closed-bundle-node-builtins-only-v1",
          interpreter: {path: "/ar-custody-node", mode: 0o555, size: 100,
            sha256: "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c"},
          bootstrap: {path: "/ar-custody-init.mjs", mode: 0o444, size: 85430,
            sha256: "e54bf7263a01b3ccc48a0b401a48eb14be60ce27520edd2bd865d04e3f04674c"},
        },
        native: {catalogSource: Buffer.from("{}"), ownerUid: 1000, ownerGid: 1000},
        observerSha256: "c".repeat(64), certificateAuthorities: [trustedCa],
      } satisfies Parameters<typeof createLinuxCodexLiveCanaryConfiguration>[1];
      const {approval, configuration} = createLinuxCodexLiveCanaryConfiguration(approved, pins);
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
      assert.match(policyRevision, /^linux-codex-marker-canary:v1:[a-f0-9]{64}$/u);
      assert.equal(approval.intentAuthority.authorityRevision, policyRevision);
      assert.equal(approval.egressRule.policyRef, policyRevision);
      assert.equal(approval.egressRule.revision, policyRevision);
      assert.deepEqual(await configuration.policy.read({
        scope: approval.dispatchPolicy.scope, providerId: approval.dispatchPolicy.providerId,
        intentDigest: approval.dispatchPolicy.intentDigest, policyRevision,
      }), approval.dispatchPolicy);
      assert.equal(configuration.authorityRevision,
        `runtime-access-authority:linux-codex-marker-canary-v1-${policyRevision.slice("linux-codex-marker-canary:v1:".length)}`);
      assert.equal(configuration.authorityRevision.length, 118);
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
