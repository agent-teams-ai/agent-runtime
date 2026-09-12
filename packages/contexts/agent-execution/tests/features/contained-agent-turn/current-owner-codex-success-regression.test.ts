import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createContainedTurnFeature, createCodexCurrentKernelOwner } from "../../../dist/composition.js";
import {
  createCodexAppServerPermissionBoundary, validateCodexConfigEvidence, validateCodexInitializeEvidence,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_LINUX_X64_TUPLE as tuple } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import { BoundedCodexJsonLineReader, encodeCodexMessage } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-jsonl.js";
import { DeterministicCurrentOwnerHost } from "../../current-owner-success-fixture.ts";
import { awaitFixtureGate, createDependencies } from "./support/contained-agent-turn-fixture.ts";
import { syntheticCodexEffectCustody } from "./support/current-provider-owner-fixture.ts";

const initialization = Object.freeze({
  platformFamily: tuple.platformFamily, platformOs: tuple.platformOs,
  userAgent: `agent-runtime/${tuple.version} (${tuple.userAgentOsName} 24.04; ${tuple.userAgentArchitecture}) synthetic (agent-runtime; ${tuple.adapterRevision})`,
});

const createFixture = async (intentMode: "analysis" | "workspace-write") => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "current-owner-codex-regression-")));
  const workspaceRef = join(root, "workspace");
  const privateRootPath = join(root, "private");
  const codexHome = join(privateRootPath, "home");
  const temp = join(privateRootPath, "temp");
  await Promise.all([workspaceRef, codexHome, temp].map(path => mkdir(path, {recursive: true, mode: 0o700})));
  const boundary = createCodexAppServerPermissionBoundary({codexHome, intentMode, workspaceRef});
  const host = new DeterministicCurrentOwnerHost(initialization);
  const owner = createCodexCurrentKernelOwner({
    effectCustody: syntheticCodexEffectCustody(),
    hostBootId: "host-boot:codex-regression", hostCustody: host as never,
    hostInstanceId: "host-instance:codex-regression", platformTarget: {architecture: "x64", platform: "linux"},
    launchRecords: {resolve: async input => ({
      boundary, credentialOutputInventory: Object.freeze({
        credentialBindingDigest: input.credentialBindingDigest,
        credentialGeneration: input.credentialGeneration,
        sensitiveOutputTokens: Object.freeze([]),
      }),
      executablePath: "/synthetic/codex", privateRootPath, tmpDir: temp,
    })},
    workspaceOwner: {async withLaunchAuthority(_input, consume) {
      return consume({canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
        identity: {dev: 1n, ino: 2n, mountId: "mount:codex-regression"}});
    }},
  });
  return {boundary, host, owner, cleanup: async () => {
    owner.dispose();
    await rm(root, {recursive: true, force: true});
  }};
};

for (const mode of ["analysis", "workspace-write"] as const) {
  test(`current-owner Codex ${mode} config/read reaches the exact 0.153.4 consumer`, async () => {
    const {boundary, host, cleanup} = await createFixture(mode);
    try {
      const custody = await host.reserve({launchPlan: boundary});
      const process = host.get(custody.custodyRef)!;
      const reader = new BoundedCodexJsonLineReader(process.stdout, 1_048_576);
      host.start(custody.custodyRef);
      await process.write(encodeCodexMessage({id: "initialize", method: "initialize"}));
      const initialized = await reader.read(performance.now() + 1_000);
      assert.ok(initialized !== null && typeof initialized === "object");
      validateCodexInitializeEvidence(initialized.result, boundary, tuple);
      await process.write(encodeCodexMessage({method: "initialized"}));
      await process.write(encodeCodexMessage({id: "config-read", method: "config/read"}));
      const response = await reader.read(performance.now() + 1_000);
      assert.ok(response !== null && typeof response === "object");
      // Keep the consumer's original error visible if this shared fixture drifts again.
      validateCodexConfigEvidence(response.result, boundary);
      const corrupt = structuredClone(response.result) as {layers: {version: string}[]};
      corrupt.layers[0]!.version = "1";
      assert.throws(() => validateCodexConfigEvidence(corrupt, boundary),
        /Codex permission evidence rejected: config layers differ from the exact launch recipe or version/u);
      await process.closeInput();
      assert.equal(await reader.read(performance.now() + 1_000), undefined);
      for await (const bytes of process.stderr) {assert.equal(bytes.byteLength, 0);}
      await process.waitForExit();
      assert.equal((await host.requestContainment(custody)).kind, "unproven",
        "stdio closure without a protocol terminal cannot mint Host finality");
      assert.equal(host.finalities, 0);
    } finally {await cleanup();}
  });
}

for (const recover of [false, true]) {
  test(`current-owner Codex ${recover ? "closure recovery" : "success"} and replay consume the deterministic protocol without PostgreSQL`, async () => {
    const {host, owner, cleanup} = await createFixture("analysis");
    let releaseClaim!: () => void;
    try {
      const fixture = createDependencies();
      const original = fixture.dependencies;
      let reportClaim!: () => void;
      const reached = new Promise<void>(resolve => {reportClaim = resolve;});
      const wait = new Promise<void>(resolve => {releaseClaim = resolve;});
      let withholdAcknowledgement = recover;
      const dependencies = {...original, custody: owner.custody, provider: owner.provider,
        operationStore: {...original.operationStore,
          identifyAcceptance: async input => {
            const current = fixture.current();
            if (current === undefined) {return original.operationStore.identifyAcceptance(input);}
            assert.deepEqual(input.scope, current.scope);
            assert.equal(input.commandId, current.commandId);
            assert.equal(input.commandFingerprint, current.commandFingerprint);
            return {kind: "replayed" as const, operation: current};
          },
          claimPreparedDispatch: async input => {
            reportClaim();
            await wait;
            return original.operationStore.claimPreparedDispatch(input);
          },
        },
        artifacts: {...original.artifacts, ensureSealed: async input => {
          const outcome = await original.artifacts.ensureSealed(input);
          if (withholdAcknowledgement && outcome.kind === "proved") {
            withholdAcknowledgement = false;
            return {evidenceId: "evidence:artifact-seal-acknowledgement-lost" as never,
              kind: "indeterminate" as const};
          }
          return outcome;
        }},
      } satisfies Parameters<typeof createContainedTurnFeature>[0];
      const feature = createContainedTurnFeature(dependencies);
      const request = {commandId: "command:codex-success-regression", expectedProvider: "codex" as const,
        intent: {mode: "analysis" as const, prompt: "Complete the deterministic protocol fixture."},
        scope: {projectId: "project:one", tenantId: "tenant:one"}};
      const submission = feature.submit.execute(request);
      await awaitFixtureGate(reached, submission);
      assert.deepEqual([host.reserves, host.starts], [1, 0], "no provider start before the atomic claim");
      releaseClaim();
      const first = await submission;
      assert.equal(first.status, "observed");
      assert.equal(first.turn.status, recover ? "reconcile_required" : "succeeded");
      assert.deepEqual([host.starts, host.containments, host.finalities], [1, 1, 1]);
      assert.equal(fixture.current()?.providerExecution.kind, "closed");
      for (const replayFeature of [feature, createContainedTurnFeature(dependencies)]) {
        const replay = await replayFeature.submit.execute(request);
        assert.equal(replay.status, "observed");
        assert.equal(replay.turn.status, "succeeded");
        assert.equal(replay.turn.operationId, first.turn.operationId);
        assert.equal(fixture.current()?.terminal.kind, "final");
        assert.deepEqual([host.reserves, host.starts, host.containments, host.finalities], [1, 1, 1, 1],
          "acceptance replay and reconstructed feature reuse the sole provider execution and Host finality");
      }
    } finally {releaseClaim?.(); await cleanup();}
  });
}
