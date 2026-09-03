import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CodexAppServerCurrentKernelAdapter } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {
  createCodexAppServerLaunchPlan,
  validateCodexAppServerLaunchPlanRoots,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {
  createCodexAppServerPermissionBoundary,
  validateCodexInitializeEvidence,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {
  assertExactCodexAppServerPlatformTuple,
  CODEX_APP_SERVER_ADAPTER_REVISION,
  CODEX_APP_SERVER_BINDINGS_SHA256,
  CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
  CODEX_APP_SERVER_LINUX_X64_TUPLE,
  CODEX_APP_SERVER_PACKAGE_REVISION,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_VERSION,
  CODEX_CAPABILITY_MANIFEST_REVISION,
  selectCodexAppServerPlatformTuple,
  validateCodexAppServerUserAgent,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import { codexReceipt } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-receipt-identity.js";
import { boundary } from "../../codex-app-server-contained-turn-provider-fixture.ts";

const linuxUserAgent =
  "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)";
const candidateAuthority = JSON.parse(readFileSync(new URL(
  "../../fixtures/protocol/codex-app-server-0.150.1/manifest.json", import.meta.url,
), "utf8")) as {readonly candidateTargets: {readonly "darwin-arm64": {
  readonly authority: string; readonly binaryPath: string; readonly binarySha256: string;
  readonly initialize: {readonly platformFamily: string; readonly platformOs: string; readonly userAgent: string};
  readonly nativePackage: string; readonly nativeTarget: string; readonly qualification: string;
  readonly wrapperPackage: string;
}}};
const darwinCandidate = candidateAuthority.candidateTargets["darwin-arm64"];
const darwinUserAgent = darwinCandidate.initialize.userAgent;

test("pins the exact experimental Codex contract and immutable capability identity", () => {
  assert.equal(CODEX_APP_SERVER_VERSION, "0.150.1");
  assert.equal(CODEX_APP_SERVER_PACKAGE_REVISION, "@openai/codex@0.150.1");
  assert.equal(CODEX_APP_SERVER_ADAPTER_REVISION,
    "codex-app-server-contained-turn:0.150.1+native-permission-config-v2");
  assert.equal(CODEX_APP_SERVER_SCHEMA_SHA256,
    "9f28c7c4c42a02af6b8a31e978188df6c14547be3c1c8dbe824313b1a8b5fa56");
  assert.equal(CODEX_APP_SERVER_BINDINGS_SHA256,
    "3b4836d6282a30cdba8ace7c3ad6fa8ee968da77ca4bf6430c05ff7c525d4fcc");
  assert.equal(CODEX_CAPABILITY_MANIFEST_REVISION,
    "contained-turn:v1:codex-app-server:0.150.1:schema-9f28c7c4c42a02af6b8a31e978188df6c14547be3c1c8dbe824313b1a8b5fa56:bindings-3b4836d6282a30cdba8ace7c3ad6fa8ee968da77ca4bf6430c05ff7c525d4fcc:agent-runtime-contained-v1:native-permission-config-v2");
  assert.equal(CODEX_APP_SERVER_LINUX_X64_TUPLE.protocolRevision, CODEX_CAPABILITY_MANIFEST_REVISION);
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.protocolRevision, CODEX_CAPABILITY_MANIFEST_REVISION);
});

test("selects the supported Codex Linux tuple and admitted static Darwin candidate", () => {
  assert.deepEqual(selectCodexAppServerPlatformTuple({ architecture: "x64", platform: "linux" }),
    CODEX_APP_SERVER_LINUX_X64_TUPLE);
  assert.deepEqual(selectCodexAppServerPlatformTuple({ architecture: "arm64", platform: "darwin" }),
    CODEX_APP_SERVER_DARWIN_ARM64_TUPLE);
  assert.equal(CODEX_APP_SERVER_LINUX_X64_TUPLE.binarySha256,
    "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386");
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.binarySha256,
    darwinCandidate.binarySha256);
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.nativePackageRevision,
    darwinCandidate.nativePackage);
  assert.equal(darwinCandidate.wrapperPackage, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.packageRevision);
  assert.equal(darwinCandidate.nativeTarget, "aarch64-apple-darwin");
  assert.equal(darwinCandidate.binaryPath, "vendor/aarch64-apple-darwin/codex/codex");
  assert.equal(darwinCandidate.authority, "checked-in-package-binary-initialize-candidate");
  assert.equal(darwinCandidate.qualification, "candidate-pending-exact-local-canary");
  assert.equal(CODEX_APP_SERVER_LINUX_X64_TUPLE.containmentProfile, "strict-linux-cgroup-v2");
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.containmentProfile,
    "cooperative-darwin-posix-process-group");
  for (const unsupported of [
    { architecture: "x64", platform: "win32" },
    { architecture: "arm64", platform: "linux" },
    { architecture: "x64", platform: "darwin" },
  ]) {assert.throws(() => selectCodexAppServerPlatformTuple(unsupported as never), /No exact/u);}
  assert.throws(() => assertExactCodexAppServerPlatformTuple({
    ...CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
    containmentProfile: "strict-linux-cgroup-v2",
  }), /tuple.*profile/u);
});

test("accepts the two real initialize observations without pinning patch or build text", () => {
  validateCodexAppServerUserAgent(linuxUserAgent, CODEX_APP_SERVER_LINUX_X64_TUPLE);
  validateCodexAppServerUserAgent(darwinUserAgent, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE);
  validateCodexAppServerUserAgent(
    "agent-runtime/0.150.1 (Ubuntu 26.10; x86_64) release.7 (agent-runtime; codex-app-server-contained-turn:0.150.1+native-permission-config-v2)",
    CODEX_APP_SERVER_LINUX_X64_TUPLE,
  );
  validateCodexInitializeEvidence({
    codexHome: boundary.codexHome,
    platformFamily: darwinCandidate.initialize.platformFamily,
    platformOs: darwinCandidate.initialize.platformOs,
    userAgent: darwinUserAgent,
  }, boundary, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE);
});

test("rejects hostile, malformed, crossed, prefixed, suffixed, and oversized initialize identities", () => {
  const hostile: readonly unknown[] = [
    darwinUserAgent,
    linuxUserAgent.replace("0.150.1", "0.150.2"),
    linuxUserAgent.replace("x86_64", "arm64"),
    linuxUserAgent.replace("Ubuntu", "Mac OS"),
    linuxUserAgent.replace("agent-runtime/", "other-client/"),
    linuxUserAgent.replace("(agent-runtime;", "(other-client;"),
    linuxUserAgent.replace("codex-app-server-contained-turn:0.150.1+native-permission-config-v2", "codex-app-server-contained-turn:other"),
    `prefix-${linuxUserAgent}`,
    `${linuxUserAgent}-suffix`,
    `${linuxUserAgent}\nprivate-path`,
    "x".repeat(513),
    Object.freeze({ value: linuxUserAgent }),
    null,
  ];
  for (const value of hostile) {
    assert.throws(() => validateCodexAppServerUserAgent(value, CODEX_APP_SERVER_LINUX_X64_TUPLE),
      /user agent/u);
  }
  const privateHome = "/private/codex/home";
  assert.throws(() => validateCodexInitializeEvidence({
    codexHome: privateHome, platformFamily: "unix", platformOs: "linux", userAgent: linuxUserAgent,
  }, boundary, CODEX_APP_SERVER_LINUX_X64_TUPLE), error => {
    assert.equal(String(error).includes(privateHome), false);
    assert.equal(String(error).includes(linuxUserAgent), false);
    return true;
  });
});

test("derives stable binding and receipt identity from the selected tuple without evidence leakage", () => {
  const attempts = {prepare: async () => {throw new Error("unused");}};
  const linux = new CodexAppServerCurrentKernelAdapter({ attempts,
    platformTarget: {architecture: "x64", platform: "linux"} });
  const darwin = new CodexAppServerCurrentKernelAdapter({ attempts,
    platformTarget: {architecture: "arm64", platform: "darwin"} });
  assert.equal(linux.adapterSnapshot.binaryRevision, CODEX_APP_SERVER_LINUX_X64_TUPLE.binaryRevision);
  assert.equal(darwin.adapterSnapshot.binaryRevision, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.binaryRevision);
  const identity = { attemptId: "attempt:stable", effectId: "effect:stable", operationId: "operation:stable" };
  const linuxReceipt = codexReceipt("codex-test", {...identity, platformTuple: CODEX_APP_SERVER_LINUX_X64_TUPLE}, ["stable"]);
  const repeated = codexReceipt("codex-test", {...identity, platformTuple: CODEX_APP_SERVER_LINUX_X64_TUPLE}, ["stable"]);
  const darwinReceipt = codexReceipt("codex-test", {...identity, platformTuple: CODEX_APP_SERVER_DARWIN_ARM64_TUPLE}, ["stable"]);
  assert.equal(repeated, linuxReceipt);
  assert.notEqual(darwinReceipt, linuxReceipt);
  for (const receipt of [linuxReceipt, darwinReceipt]) {
    assert.match(receipt, /^urn:agent-runtime:codex-test:[a-f0-9]{64}$/u);
    assert.equal(receipt.includes(boundary.codexHome), false);
    assert.equal(receipt.includes("userAgent"), false);
  }
});

test("derives Darwin launch identity and requests only the reviewed cooperative profile", () => {
  const privateRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-runtime-codex-darwin-tuple-")));
  const workspace = `${privateRoot}-workspace`;
  try {
    const codexHome = join(privateRoot, "home"); const tmp = join(privateRoot, "tmp");
    mkdirSync(codexHome, { mode: 0o700 }); mkdirSync(tmp, { mode: 0o700 }); mkdirSync(workspace);
    const exactBoundary = createCodexAppServerPermissionBoundary({ codexHome, intentMode: "analysis", workspaceRef: workspace });
    const plan = createCodexAppServerLaunchPlan({
      boundary: exactBoundary,
      executablePath: "/synthetic/codex-darwin-arm64",
      intentMode: "analysis",
      platformTarget: {architecture: "arm64", platform: "darwin"},
      privateRootPath: privateRoot,
      tmpDir: tmp,
    });
    assert.equal(plan.binaryRevision, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.binaryRevision);
    assert.equal(plan.executableSha256, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.binarySha256);
    assert.equal(plan.containmentProfile, "cooperative-darwin-posix-process-group");
    validateCodexAppServerLaunchPlanRoots(plan);
    assert.throws(() => validateCodexAppServerLaunchPlanRoots({
      ...plan,
      containmentProfile: "strict-linux-cgroup-v2",
    }), /tuple\/profile mismatch/u);
  } finally {
    rmSync(privateRoot, { force: true, recursive: true }); rmSync(workspace, { force: true, recursive: true });
  }
});
