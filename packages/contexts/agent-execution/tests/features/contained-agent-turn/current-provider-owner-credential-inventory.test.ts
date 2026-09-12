import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createCodexCurrentKernelOwner } from "../../../dist/composition.js";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {
  access, codexCredentialOutputInventory, executeInput, FakeHost, ids, openInput,
  syntheticCodexEffectCustody, workspaceOwner,
} from "./support/current-provider-owner-fixture.ts";
import {
  boundary as codexFixtureBoundary,
  FakeCodexProcess,
  standardHandshake,
  syntheticPrivateRoot as codexFixturePrivateRoot,
  syntheticTmp as codexFixtureTmp,
} from "../../codex-app-server-contained-turn-provider-fixture.ts";
import { emitAgentCompleted, emitAgentStarted, emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";

test("Codex owner immutably snapshots a valid exact Array and rejects its arbitrary review token", async () => {
  const workspaceRef = codexFixtureBoundary.workspaceRef;
  const privateRootPath = codexFixturePrivateRoot;
  const codexHome = codexFixtureBoundary.codexHome;
  const tmpDir = codexFixtureTmp;
  const oauthToken = "test-fixture-literal";
  const tokenDigest = createHash("sha256").update(oauthToken).digest("hex");
  const reviewToken = "ARBITRARY_REVIEW_TOKEN_93e77fe_exact_inventory";
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({id: message.id, result: {turn: generatedTurn("turn:sensitive", "inProgress")}});
      emitTurnStarted(target, "turn:sensitive");
      emitAgentStarted(target, "turn:sensitive", "item:sensitive");
      target.emit({method: "item/agentMessage/delta", params: {
        delta: `unlabeled ${oauthToken} ${tokenDigest} ${reviewToken}`, itemId: "item:sensitive",
        threadId: "thread:test", turnId: "turn:sensitive",
      }});
      emitAgentCompleted(target, "turn:sensitive", "item:sensitive", `unlabeled ${oauthToken} ${tokenDigest} ${reviewToken}`);
      target.emit({method: "turn/completed", params: {
        threadId: "thread:test", turn: generatedTurn("turn:sensitive", "completed"),
      }});
    }
  });
  class CredentialHost extends FakeHost {
    override async reserve(input: any) {
      this.reserves += 1;
      this.refs.set(input.attemptId, process.custodyRef);
      this.plans.push(input.launchPlan);
      return Object.freeze({custodyRef: process.custodyRef});
    }
    override get(custodyRef: string) {return custodyRef === process.custodyRef ? process : null;}
  }
  const host = new CredentialHost();
  const identity = ids("codex", "sensitive-output");
  const mutableTokens = [oauthToken, tokenDigest, reviewToken];
  const mutableInventory = {
    credentialBindingDigest: access("codex").credentialBindingDigest,
    credentialGeneration: access("codex").credentialGeneration,
    sensitiveOutputTokens: mutableTokens,
  };
  const owner = createCodexCurrentKernelOwner({
    effectCustody: syntheticCodexEffectCustody(), hostBootId: "host-boot:sensitive-output",
    hostCustody: host as any, hostInstanceId: "host-instance:sensitive-output",
    launchRecords: {resolve: async () => ({
      boundary: createCodexAppServerPermissionBoundary({codexHome, intentMode: "analysis", workspaceRef}),
      credentialOutputInventory: mutableInventory,
      executablePath: "/synthetic/codex", privateRootPath, tmpDir,
    })},
    platformTarget: {architecture: "x64", platform: "linux"},
    workspaceOwner: workspaceOwner(identity, workspaceRef),
  });
  await owner.custody.open(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT));
  mutableTokens.splice(0, mutableTokens.length, "later-substituted-token");
  mutableInventory.credentialBindingDigest = "later-substituted-digest" as never;
  mutableInventory.credentialGeneration = 2;
  const output: unknown[] = [];
  const outcome = await owner.provider.execute({...executeInput(
    identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
  ), emit: async chunk => {output.push(chunk);}});
  const publicEvidence = JSON.stringify({outcome, output});
  assert.equal(outcome.kind, "indeterminate");
  assert.deepEqual(output, []);
  assert.equal(publicEvidence.includes(oauthToken), false);
  assert.equal(publicEvidence.includes(tokenDigest), false);
  assert.equal(publicEvidence.includes(reviewToken), false);
  assert.equal(JSON.stringify(openInput(identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT))
    .includes(oauthToken), false);
  owner.dispose();
});
test("Codex production owner fails closed on omitted or credential-drifted output inventory", async () => {
  for (const [suffix, inventory] of [
    ["omitted", undefined],
    ["digest", {...codexCredentialOutputInventory(access("codex")), credentialBindingDigest: "drifted"}],
    ["generation", {...codexCredentialOutputInventory(access("codex")), credentialGeneration: 2}],
  ] as const) {
    const identity = ids("codex", `inventory-${suffix}`);
    const owner = createCodexCurrentKernelOwner({
      effectCustody: syntheticCodexEffectCustody(), hostBootId: `host-boot:inventory-${suffix}`,
      hostCustody: new FakeHost() as any, hostInstanceId: `host-instance:inventory-${suffix}`,
      launchRecords: {resolve: async () => ({
        boundary: codexFixtureBoundary,
        ...(inventory === undefined ? {} : {credentialOutputInventory: inventory}),
        executablePath: "/synthetic/codex", privateRootPath: codexFixturePrivateRoot, tmpDir: codexFixtureTmp,
      } as never)},
      platformTarget: {architecture: "x64", platform: "linux"},
      workspaceOwner: workspaceOwner(identity, codexFixtureBoundary.workspaceRef),
    });
    await assert.rejects(owner.custody.open(openInput(
      identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
    )), /credential output inventory/u);
    owner.dispose();
  }
});

test("Codex credential inventory accepts only bounded dense exact Arrays without dispatching accessors", async t => {
  let accessorReads = 0;
  class OverriddenMapArray extends Array<string> {
    override map<U>(_callback: (value: string, index: number, array: string[]) => U): U[] {return [];}
  }
  const cases: readonly [string, () => unknown][] = [
    ["Array subclass overriding map", () => new OverriddenMapArray("subclass-secret")],
    ["own overridden map", () => Object.defineProperty(["own-map-secret"], "map", {value: () => []})],
    ["hostile prototype", () => Object.setPrototypeOf(["prototype-secret"], Object.create(Array.prototype))],
    ["own accessor", () => Object.defineProperty(["accessor-secret"], "0", {
      configurable: true, enumerable: true, get: () => {accessorReads += 1; return "accessor-secret";},
    })],
    ["sparse Array", () => Array<string>(1)],
    ["non-string entry", () => [1]],
    ["empty entry", () => [""]],
    ["excessive count", () => Array.from({length: 257}, () => "x")],
    ["excessive individual bytes", () => ["é".repeat(2_049)]],
    ["excessive aggregate bytes", () => Array.from({length: 17}, () => "x".repeat(4_096))],
  ];
  for (const [suffix, tokens] of cases) {
    await t.test(suffix, async () => {
      const identity = ids("codex", `credential-array-${suffix.replaceAll(" ", "-")}`);
      const host = new FakeHost();
      const owner = createCodexCurrentKernelOwner({
        effectCustody: syntheticCodexEffectCustody(), hostBootId: "host-boot:credential-array",
        hostCustody: host as any, hostInstanceId: "host-instance:credential-array",
        launchRecords: {resolve: async input => ({
          boundary: codexFixtureBoundary,
          credentialOutputInventory: {
            credentialBindingDigest: input.credentialBindingDigest,
            credentialGeneration: input.credentialGeneration, sensitiveOutputTokens: tokens(),
          },
          executablePath: "/synthetic/codex", privateRootPath: codexFixturePrivateRoot, tmpDir: codexFixtureTmp,
        } as never)},
        platformTarget: {architecture: "x64", platform: "linux"},
        workspaceOwner: workspaceOwner(identity, codexFixtureBoundary.workspaceRef),
      });
      await assert.rejects(owner.custody.open(openInput(
        identity, "codex", CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT,
      )), /credential output inventory/u);
      assert.equal(host.reserves, 0);
      assert.equal(host.starts, 0);
      owner.dispose();
    });
  }
  assert.equal(accessorReads, 0);
});
