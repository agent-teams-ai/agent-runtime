import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import {
  assertCodexCanonicalOutputAllowed,
  CODEX_CREDENTIAL_POLICY_FAMILIES,
  codexTextContainsPrivatePath,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-output-policy.js";
import { agentMessage, emitAgentCompleted, emitAgentStarted, emitTurnStarted, generatedTurn } from "../../codex-app-server-test-messages.mjs";
import {
  FakeCodexProcess,
  boundary,
  executeInput,
  manifest,
  standardHandshake,
  syntheticPrivateRoot,
  syntheticTmp,
} from "../../codex-app-server-contained-turn-provider-fixture.ts";

type OutputChunk = { readonly cursor: number; readonly kind: string; readonly text: string };
type CredentialFamily = (typeof CODEX_CREDENTIAL_POLICY_FAMILIES)[number];

const CREDENTIAL_MATRIX: readonly Readonly<{
  family: CredentialFamily;
  name: string;
  text: string;
}>[] = Object.freeze([
  { family: "synthetic-marker", name: "credential marker", text: "CrEdEnTiAl_MaRkEr <synthetic>" },
  { family: "synthetic-marker", name: "api-key marker", text: "api-key-marker<synthetic>" },
  { family: "synthetic-marker", name: "access-token marker", text: "ACCESS TOKEN MARKER <synthetic>" },
  { family: "synthetic-marker", name: "refresh-token marker", text: "refresh_token_marker<synthetic>" },
  { family: "private-key-marker", name: "generic private key", text: "-----begin private key-----" },
  { family: "private-key-marker", name: "RSA private key", text: "-----BEGIN RSA PRIVATE KEY-----" },
  { family: "private-key-marker", name: "EC private key", text: "-----Begin Ec Private Key-----" },
  { family: "private-key-marker", name: "OpenSSH private key", text: "----- BEGIN OPENSSH PRIVATE KEY -----" },
  { family: "openai-sk-credential", name: "embedded sk credential", text: "ask-0123456789abcdefghij-suffix" },
  { family: "api-key-assignment", name: "OpenAI API key assignment", text: "OPENAI API KEY = '0123456789abcdef'" },
  { family: "api-key-assignment", name: "Codex API key assignment", text: "prefix-CoDeX_ApI-Key : abcdefghijklmnop-suffix" },
  { family: "authorization-bearer", name: "Authorization bearer", text: "AUTHORIZATION \t:  BEARER \n0123456789abcdef" },
  { family: "token-field", name: "JSON access token", text: "{ \"Access_Token\" \t: \t\"0123456789abcdef\" }" },
  { family: "token-field", name: "refresh-token assignment", text: "refresh-token = '0123456789abcdef'" },
  { family: "token-field", name: "id token assignment", text: "prefix id token: 0123456789abcdef suffix" },
]);

const assertContainmentRequired = (
  outcome: Awaited<ReturnType<CodexAppServerContainedTurnProvider["execute"]>>,
): void => {
  assert.equal(outcome.kind, "ambiguous");
  assert.equal("containmentRequired" in outcome && outcome.containmentRequired, true);
  assert.equal("integrationRequired" in outcome && outcome.integrationRequired,
    "kernel-custody-containment-reconciliation/v1");
  assert.equal("outputDrainProven" in outcome && outcome.outputDrainProven, false);
};

const executeAssistantChunks = async (
  turnId: string,
  chunksByItem: readonly (readonly string[])[],
  sensitiveOutputTokens: readonly string[] = [],
  maximumBytes?: number,
) => {
  const output: OutputChunk[] = [];
  const items = chunksByItem.map((chunks, index) => agentMessage(`item:${index}`, chunks.join("")));
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method !== "turn/start") {return;}
    target.emit({ id: message.id, result: { turn: generatedTurn(turnId, "inProgress") } });
    emitTurnStarted(target, turnId);
    for (const [index, item] of items.entries()) {
      emitAgentStarted(target, turnId, item.id);
      for (const delta of chunksByItem[index] ?? []) {
        target.emit({ method: "item/agentMessage/delta", params: {
          delta, itemId: item.id, threadId: "thread:test", turnId,
        } });
      }
      emitAgentCompleted(target, turnId, item.id, item.text);
    }
    target.emit({ method: "turn/completed", params: {
      threadId: "thread:test", turn: generatedTurn(turnId, "completed", null, items),
    } });
  });
  const provider = new CodexAppServerContainedTurnProvider({
    boundary, manifest, ...(maximumBytes === undefined ? {} : { maxActiveNotificationBytes: maximumBytes }),
    privateRootPath: syntheticPrivateRoot, processes: { get: () => process }, sensitiveOutputTokens, tmpDir: syntheticTmp,
  });
  const outcome = await provider.execute({
    ...executeInput(process), emit: async chunk => {output.push(chunk);},
  });
  return { outcome, output };
};

const executeAssistantItems = (
  turnId: string,
  texts: readonly string[],
  sensitiveOutputTokens: readonly string[] = [],
) => executeAssistantChunks(turnId, texts.map(text => [text]), sensitiveOutputTokens);

test("credential matrix covers every declared family and rejects every item split without leaking a prior prefix", async () => {
  assert.equal(CREDENTIAL_MATRIX.length, 15, "removing an individual credential matrix row must fail coverage");
  assert.deepEqual(new Set(CREDENTIAL_MATRIX.map(entry => entry.family)), new Set(CODEX_CREDENTIAL_POLICY_FAMILIES));
  let sequence = 0;
  for (const entry of CREDENTIAL_MATRIX) {
    for (let split = 0; split <= entry.text.length; split += 1) {
      const evidence = await executeAssistantItems(`turn:credential:${sequence}`, [
        "ordinary assistant prefix\n", entry.text.slice(0, split), entry.text.slice(split),
      ]);
      sequence += 1;
      assertContainmentRequired(evidence.outcome);
      assert.deepEqual(evidence.output, [], `${entry.name} leaked at item split ${split}`);
      assert.equal(JSON.stringify(evidence).includes(entry.text), false);
    }
  }
});

test("the embedded ask- counterexample rejects at every delta split", async () => {
  const credential = "ask-0123456789abcdefghij-suffix";
  for (let split = 0; split <= credential.length; split += 1) {
    const evidence = await executeAssistantChunks(`turn:ask:${split}`, [[
      credential.slice(0, split), credential.slice(split),
    ]]);
    assertContainmentRequired(evidence.outcome);
    assert.deepEqual(evidence.output, []);
  }
});

test("joining or splitting ordinary provider text preserves admission and deterministic cursors", async () => {
  const text = "Ordinary prose may mention sk-short, bearer auth, or an access token without a complete credential shape.";
  for (let split = 0; split <= text.length; split += 1) {
    const evidence = await executeAssistantItems(`turn:ordinary:${split}`, [text.slice(0, split), text.slice(split)]);
    assert.equal(evidence.outcome.kind, "completed");
    assert.deepEqual(evidence.output, [{ cursor: 0, kind: "assistant", text }]);
  }
});

test("private paths use Linux byte identity and Darwin/Windows canonical caseless identity", () => {
  const nfc = "/Private/Caf\u00e9/Codex";
  const nfdDifferentCase = "/private/cafe\u0301/cODEX";
  const cases = [
    { expected: false, path: nfc, platform: "linux" as const, text: nfdDifferentCase },
    { expected: true, path: nfc, platform: "darwin" as const, text: `prefix ${nfdDifferentCase} suffix` },
    { expected: true, path: "C:\\Users\\Private\\Codex", platform: "win32" as const,
      text: "prefix c:\\users\\private\\CODEX suffix" },
    { expected: false, path: "/private/root", platform: "linux" as const, text: "/PRIVATE/ROOT" },
  ];
  assert.equal(cases.length, 4, "removing a platform-path matrix row must fail coverage");
  for (const entry of cases) {
    assert.equal(codexTextContainsPrivatePath(entry.text, [entry.path], entry.platform), entry.expected);
  }
});

test("exact owner tokens and platform paths remain separate bounded policy inputs", () => {
  const policy = Object.freeze({
    exactSensitiveTokens: Object.freeze(["owner-token-012345"]),
    privatePaths: Object.freeze(["/Private/Caf\u00e9/Codex"]),
    privatePathPlatform: "darwin" as const,
  });
  assert.throws(() => assertCodexCanonicalOutputAllowed("owner-token-012345", policy));
  assert.throws(() => assertCodexCanonicalOutputAllowed("/private/cafe\u0301/codex", policy));
  assert.doesNotThrow(() => assertCodexCanonicalOutputAllowed("ordinary output", policy));
});

test("whole-turn admission clears terminal prefixes and uses bounded notification retention", async () => {
  const terminal = await executeAssistantItems("turn:prefixes", ["alphaAB", "XbetaB", "YomegaABC"], [
    "ABCD", "BCD", "!",
  ]);
  assert.equal(terminal.outcome.kind, "completed");
  assert.deepEqual(terminal.output, [{ cursor: 0, kind: "assistant", text: "alphaABXbetaBYomega" }]);

  const bounded = await executeAssistantChunks("turn:bounded", [["x".repeat(256)]], [], 64);
  assertContainmentRequired(bounded.outcome);
  assert.deepEqual(bounded.output, []);

  const process = new FakeCodexProcess(() => {});
  assert.throws(() => new CodexAppServerContainedTurnProvider({
    boundary, manifest, privateRootPath: syntheticPrivateRoot, processes: { get: () => process },
    sensitiveOutputTokens: [""], tmpDir: syntheticTmp,
  }), /bounded non-empty string/u);
});

test("private roots and exact sensitive tokens never preserve an earlier public emission", async () => {
  const privateSecret = "AR_PRIVATE_SPLIT_SENTINEL_1f82";
  for (const [name, secret] of [["private-root", syntheticPrivateRoot], ["exact-token", privateSecret]] as const) {
    const split = Math.floor(secret.length / 2);
    const evidence = await executeAssistantItems(`turn:${name}`, [
      "public assistant chunk", secret.slice(0, split), secret.slice(split),
    ], name === "exact-token" ? [privateSecret] : []);
    assertContainmentRequired(evidence.outcome);
    assert.deepEqual(evidence.output, []);
    assert.equal(JSON.stringify(evidence).includes(secret), false);
  }
});
