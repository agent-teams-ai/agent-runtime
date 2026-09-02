import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CodexAppServerContainedTurnProvider,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import {
  createCodexActiveTurnProgress,
  handleCodexActiveMessage,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-active-turn.js";
import {
  CODEX_APP_SERVER_PROTOCOL_ERROR_CODE,
  codexResponseResult,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-jsonl.js";
import {
  assertCodexCanonicalOutputAllowed,
  CODEX_CREDENTIAL_POLICY_FAMILIES,
  codexTerminalOutputText,
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
  { family: "private-key-marker", name: "encrypted private key", text: "-----BEGIN ENCRYPTED PRIVATE KEY-----" },
  { family: "openai-sk-credential", name: "embedded sk credential", text: "ask-0123456789abcdefghij-suffix" },
  { family: "api-key-assignment", name: "OpenAI API key assignment", text: "OPENAI API KEY = '0123456789abcdef'" },
  { family: "api-key-assignment", name: "Codex API key assignment", text: "prefix-CoDeX_ApI-Key : abcdefghijklmnop-suffix" },
  { family: "authorization-bearer", name: "Authorization bearer", text: "AUTHORIZATION \t:  BEARER \n0123456789abcdef" },
  { family: "authorization-bearer", name: "quoted JSON Authorization bearer",
    text: "\"Authorization\" : \"Bearer 0123456789abcdef\"" },
  { family: "api-key-assignment", name: "generic JSON api_key", text: "{\"api_key\" : \"0123456789abcdef\"}" },
  { family: "token-field", name: "JSON access token", text: "{ \"Access_Token\" \t: \t\"0123456789abcdef\" }" },
  { family: "token-field", name: "refresh-token assignment", text: "refresh-token = '0123456789abcdef'" },
  { family: "token-field", name: "id token assignment", text: "prefix id token: 0123456789abcdef suffix" },
]);

const TERMINAL_PREFIX_LANGUAGES = Object.freeze([
  "CrEdEnTiAl_MaRkEr <", "api-key-marker<", "ACCESS TOKEN MARKER <", "refresh_token_marker<",
  "-----begin private key-----", "-----BEGIN RSA PRIVATE KEY-----", "-----Begin Ec Private Key-----",
  "----- BEGIN OPENSSH PRIVATE KEY -----", "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "sk-0123456789abcdefghij", "OPENAI API KEY = '0123456789abcdef", "CoDeX_ApI-Key : abcdefghijklmnop",
  "AUTHORIZATION \t:  BEARER \n0123456789abcdef", "\"Authorization\" : \"Bearer 0123456789abcdef",
  "\"api_key\" : \"0123456789abcdef", "\"Access_Token\" : \"0123456789abcdef",
  "refresh-token = '0123456789abcdef", "id token: 0123456789abcdef",
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

const assertEveryPathPrefixRetained = (
  privatePath: string,
  spelling: string,
  platform: "darwin" | "linux" | "win32",
): void => {
  const policy = {exactSensitiveTokens: [], privatePaths: [privatePath], privatePathPlatform: platform};
  for (let length = 1; length < spelling.length; length += 1) {
    assert.equal(codexTerminalOutputText(`public:${spelling.slice(0, length)}`, policy), "",
      `${platform} admitted ${JSON.stringify(spelling.slice(0, length))}`);
  }
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

const executeTerminalBoundary = async (status: "failed" | "interrupted", text: string) => {
  const output: OutputChunk[] = [];
  const turnId = `turn:terminal:${status}`;
  const item = agentMessage("item:terminal", text);
  const terminal = (target: FakeCodexProcess) => target.emit({method: "turn/completed", params: {
    threadId: "thread:test",
    turn: generatedTurn(turnId, status, status === "failed"
      ? {additionalDetails: null, codexErrorInfo: "other", message: "hostile provider failure detail"} : null, [item]),
  }});
  const process = new FakeCodexProcess((message, target) => {
    if (standardHandshake(message, target)) {return;}
    if (message.method === "turn/start") {
      target.emit({id: message.id, result: {turn: generatedTurn(turnId, "inProgress")}});
      emitTurnStarted(target, turnId);
      emitAgentStarted(target, turnId, item.id);
      target.emit({method: "item/agentMessage/delta", params: {
        delta: text, itemId: item.id, threadId: "thread:test", turnId,
      }});
      emitAgentCompleted(target, turnId, item.id, text);
      if (status === "failed") {terminal(target);}
    }
    if (message.method === "turn/interrupt" && status === "interrupted") {
      target.emit({id: message.id, result: {}});
      terminal(target);
    }
  });
  const provider = new CodexAppServerContainedTurnProvider({
    boundary, cancellationPollMs: 1, manifest, privateRootPath: syntheticPrivateRoot,
    processes: {get: () => process}, tmpDir: syntheticTmp,
  });
  const outcome = await provider.execute({...executeInput(process), emit: async chunk => {output.push(chunk);},
    isCancellationRequested: async () => status === "interrupted"});
  return {outcome, output};
};

test("credential matrix covers every declared family and rejects every item split without leaking a prior prefix", async () => {
  assert.equal(CREDENTIAL_MATRIX.length, 18, "removing an individual credential matrix row must fail coverage");
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
      const deltaEvidence = await executeAssistantChunks(`turn:credential-delta:${sequence}`, [[
        entry.text.slice(0, split), entry.text.slice(split),
      ]]);
      sequence += 1;
      assertContainmentRequired(deltaEvidence.outcome);
      assert.deepEqual(deltaEvidence.output, [], `${entry.name} leaked at delta split ${split}`);
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
    { expected: true, path: "C:\\Users\\Caf\u00e9\\Codex", platform: "win32" as const,
      text: "prefix \\\\?\\c:/USERS/cafe\u0301/CODEX suffix" },
    { expected: true, path: "\\\\Server\\Private Share\\Codex", platform: "win32" as const,
      text: "prefix \\\\?\\UNC\\server/private share/CODEX suffix" },
    { expected: true, path: "\\\\Server\\Private Share\\Codex", platform: "win32" as const,
      text: "prefix //SERVER/PRIVATE SHARE/codex suffix" },
    { expected: false, path: "/private/root", platform: "linux" as const, text: "/PRIVATE/ROOT" },
  ];
  assert.equal(cases.length, 7, "removing a platform-path matrix row must fail coverage");
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

test("provider-controlled JSON-RPC detail, method, path, and output never enter thrown errors", async () => {
  const hostile = "PRIVATE_PROVIDER_DETAIL_/private/path_api_key";
  assert.throws(() => codexResponseResult({id: "request:1", error: {message: hostile}}, "request:1"), error => {
    assert.equal(error instanceof Error && error.message.includes(hostile), false);
    assert.equal(error !== null && typeof error === "object" && "code" in error && error.code,
      CODEX_APP_SERVER_PROTOCOL_ERROR_CODE);
    return true;
  });
  const progress = createCodexActiveTurnProgress();
  const outputPolicy = Object.freeze({exactSensitiveTokens: Object.freeze([]), privatePaths: Object.freeze([]),
    privatePathPlatform: "linux" as const});
  await assert.rejects(handleCodexActiveMessage({
    boundary, emitInput: {} as never, maxNotificationBytes: 1_024, maxNotifications: 16,
    message: {id: "hostile:1", method: hostile}, mode: "analysis", observeProtocolTerminal() {},
    outputPolicy, progress, threadId: "thread:test", turnId: "turn:test",
  }), error => error instanceof Error && !error.message.includes(hostile));
  await assert.rejects(handleCodexActiveMessage({
    boundary, emitInput: {} as never, maxNotificationBytes: 1_024, maxNotifications: 16,
    message: {method: hostile, params: {}}, mode: "analysis", observeProtocolTerminal() {},
    outputPolicy, progress: createCodexActiveTurnProgress(), threadId: "thread:test", turnId: "turn:test",
  }), error => error instanceof Error && !error.message.includes(hostile));
  assert.throws(() => assertCodexCanonicalOutputAllowed(hostile,
    {...outputPolicy, privatePaths: ["/private/path"]}), error =>
    error instanceof Error && !error.message.includes(hostile) && !error.message.includes("/private/path"));
});

test("accepts only exact official App Server response envelopes", () => {
  assert.deepEqual(codexResponseResult({id: "request:1", result: null}, "request:1"), null);
  assert.throws(() => codexResponseResult({
    error: {code: -32_000, data: {reason: "bounded"}, message: "rejected"}, id: "request:1",
  }, "request:1"), error => error instanceof Error && "explicitlyRejected" in error && error.explicitlyRejected === true);
  for (const message of [
    {id: "request:1"},
    {error: {code: -32_000, message: "rejected"}, id: "request:1", result: {}},
    {id: "request:1", result: {}, unknown: true},
    {error: {code: -32_000}, id: "request:1"},
    {error: {code: -32_000.5, message: "rejected"}, id: "request:1"},
    {error: {code: -32_000, message: "rejected", unknown: true}, id: "request:1"},
  ]) {
    assert.throws(() => codexResponseResult(message, "request:1"), error =>
      error instanceof Error && "explicitlyRejected" in error && error.explicitlyRejected === false);
  }
});

test("terminal admission retains every credential, exact-token, and normalized private-path prefix", () => {
  const basePolicy = Object.freeze({exactSensitiveTokens: Object.freeze([]), privatePaths: Object.freeze([]),
    privatePathPlatform: "linux" as const});
  assert.equal(TERMINAL_PREFIX_LANGUAGES.length, 18);
  for (const [name, language] of TERMINAL_PREFIX_LANGUAGES.entries()) {
    for (let length = 1; length < language.length; length += 1) {
      const candidate = `public:${language.slice(0, length)}`;
      try {assertCodexCanonicalOutputAllowed(candidate, basePolicy);} catch {continue;}
      assert.equal(codexTerminalOutputText(candidate, basePolicy), "",
        `credential language ${name} prefix length ${length} was admitted`);
    }
  }
  const skWithNineteenBodyCharacters = "sk-0123456789abcdefghi";
  assert.equal(codexTerminalOutputText(`public:${skWithNineteenBodyCharacters}`, basePolicy), "");

  const exact = "owner-token-012345";
  for (let length = 1; length < exact.length; length += 1) {
    assert.equal(codexTerminalOutputText(`public:${exact.slice(0, length)}`,
      {...basePolicy, exactSensitiveTokens: [exact]}), "");
  }
  const windowsRoot = "\\\\Server\\Private\\Caf\u00e9";
  const windowsPrefix = "\\\\?\\UNC\\server/private/caf\u00e9".slice(0, -1);
  assert.equal(codexTerminalOutputText(`public:${windowsPrefix}`,
    {...basePolicy, privatePaths: [windowsRoot], privatePathPlatform: "win32"}), "");
  for (let length = 1; length < syntheticPrivateRoot.length; length += 1) {
    assert.equal(codexTerminalOutputText(`public:${syntheticPrivateRoot.slice(0, length)}`,
      {...basePolicy, privatePaths: [syntheticPrivateRoot]}), "",
      `private root prefix length ${length} was admitted`);
  }
  assert.equal(codexTerminalOutputText("ordinary terminal output", basePolicy), "ordinary terminal output");
});

test("terminal path admission covers every decomposed and Windows grammar prefix", () => {
  const darwinNfc = "/Users/Private/Café/CODEX";
  assertEveryPathPrefixRetained(darwinNfc, darwinNfc.normalize("NFD").toLowerCase(), "darwin");

  const drive = "C:\\Users\\Private\\Café\\CODEX";
  const driveBody = "c:/users/private/café/codex";
  for (const spelling of [drive, driveBody, `\\\\?\\${driveBody}`, `//./${driveBody}`, `/??/${driveBody}`]) {
    assertEveryPathPrefixRetained(drive, spelling, "win32");
  }
  const unc = "\\\\Server\\Private Share\\Café\\CODEX";
  const uncBody = "server/private share/café/codex";
  for (const spelling of [unc, `//${uncBody}`, `\\\\?\\UNC\\${uncBody}`,
    `//./UNC/${uncBody}`, `/??/UNc/${uncBody}`]) {
    assertEveryPathPrefixRetained(unc, spelling, "win32");
  }
  assert.equal(codexTerminalOutputText("public:\\\\?\\UN", {
    exactSensitiveTokens: [], privatePaths: [unc], privatePathPlatform: "win32",
  }), "");

  const linuxNfc = "/private/Café/CODEX";
  const linuxNfd = linuxNfc.normalize("NFD");
  const byteDistinctLinuxText = `${linuxNfd.slice(0, -1)}!`;
  assert.equal(codexTerminalOutputText(byteDistinctLinuxText, {
    exactSensitiveTokens: [], privatePaths: [linuxNfc], privatePathPlatform: "linux",
  }), byteDistinctLinuxText, "Linux must retain byte-sensitive decomposition identity");
});

test("canonicalizes repeated separators and dot-segment aliases before private-path comparison", () => {
  const cases = [
    {path: "/srv/private/codex", platform: "linux" as const, text: "/srv//private/./stage/../codex"},
    {path: "/Users/Private/Codex", platform: "darwin" as const,
      text: "/users///private/cache/.././CODEX"},
    {path: "C:\\Users\\Private\\Codex", platform: "win32" as const,
      text: "\\\\?\\C:\\Users\\Public\\..\\Private\\.\\Codex"},
    {path: "\\\\Server\\Private Share\\Codex", platform: "win32" as const,
      text: "//?/UNC//server/decoy/../private share/./codex"},
  ];
  for (const entry of cases) {
    assert.equal(codexTextContainsPrivatePath(entry.text, [entry.path], entry.platform), true);
    assert.throws(() => assertCodexCanonicalOutputAllowed(entry.text, {
      exactSensitiveTokens: [], privatePaths: [entry.path], privatePathPlatform: entry.platform,
    }), error => error instanceof Error && !error.message.includes(entry.path));
  }
  assert.equal(codexTextContainsPrivatePath("/srv/private-other/./codex", ["/srv/private/codex"], "linux"), false);
  assert.equal(codexTextContainsPrivatePath("C:\\Users\\PrivateOther\\..\\Public\\Codex",
    ["C:\\Users\\Private\\Codex"], "win32"), false);
});

test("whole-turn admission clears terminal prefixes and uses bounded notification retention", async () => {
  const terminal = await executeAssistantItems("turn:prefixes", ["alphaAB", "XbetaB", "YomegaABC"], [
    "ABCD", "BCD", "!",
  ]);
  assert.equal(terminal.outcome.kind, "completed");
  assert.deepEqual(terminal.output, []);

  const bounded = await executeAssistantChunks("turn:bounded", [["x".repeat(256)]], [], 64);
  assertContainmentRequired(bounded.outcome);
  assert.deepEqual(bounded.output, []);

  const process = new FakeCodexProcess(() => {});
  assert.throws(() => new CodexAppServerContainedTurnProvider({
    boundary, manifest, privateRootPath: syntheticPrivateRoot, processes: { get: () => process },
    sensitiveOutputTokens: [""], tmpDir: syntheticTmp,
  }), /bounded non-empty string/u);
});

test("failed and cancelled completion never emit retained credential or private-path prefixes", async () => {
  const completed = await executeAssistantItems("turn:completed-prefix", [syntheticPrivateRoot.slice(0, -1)]);
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(completed.output, []);
  const failed = await executeTerminalBoundary("failed", syntheticPrivateRoot.slice(0, -1));
  assert.equal(failed.outcome.kind, "completed");
  assert.deepEqual(failed.output, [{cursor: 0, kind: "diagnostic",
    text: "codex-provider-terminal-failure-redacted/v1"}]);
  const cancelled = await executeTerminalBoundary("interrupted", "sk-0123456789abcdefghi");
  assert.equal(cancelled.outcome.kind, "completed");
  assert.deepEqual(cancelled.output, []);
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
