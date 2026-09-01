import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
  CODEX_APP_SERVER_LINUX_X64_TUPLE,
  selectCodexAppServerPlatformTuple,
  validateCodexAppServerUserAgent,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import { codexReceipt } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-receipt-identity.js";
import { boundary } from "../../codex-app-server-contained-turn-provider-fixture.ts";

const linuxUserAgent =
  "agent-runtime/0.150.1 (Ubuntu 24.4.0; x86_64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1)";
const darwinUserAgent =
  "agent-runtime/0.150.1 (Mac OS 15.6.1; arm64) unknown (agent-runtime; codex-app-server-contained-turn:0.150.1)";

test("selects only the exact qualified Codex Linux and Darwin tuples", () => {
  assert.deepEqual(selectCodexAppServerPlatformTuple({ architecture: "x64", platform: "linux" }),
    CODEX_APP_SERVER_LINUX_X64_TUPLE);
  assert.deepEqual(selectCodexAppServerPlatformTuple({ architecture: "arm64", platform: "darwin" }),
    CODEX_APP_SERVER_DARWIN_ARM64_TUPLE);
  assert.equal(CODEX_APP_SERVER_LINUX_X64_TUPLE.binarySha256,
    "abf1bb1643a79f73aa78ee627e111e02d4f8c98f25813a0cf6ce277709664386");
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.binarySha256,
    "a14f9a907c12c8812878b70e6b7d65f81c39ed795513e46a55817d7428c0ca6b");
  assert.equal(CODEX_APP_SERVER_LINUX_X64_TUPLE.containmentProfile, "strict-linux-cgroup-v2");
  assert.equal(CODEX_APP_SERVER_DARWIN_ARM64_TUPLE.containmentProfile,
    "cooperative-darwin-posix-process-group");
  for (const unsupported of [
    { architecture: "x64", platform: "win32" },
    { architecture: "arm64", platform: "linux" },
    { architecture: "x64", platform: "darwin" },
  ]) {assert.throws(() => selectCodexAppServerPlatformTuple(unsupported), /No exact/u);}
  assert.throws(() => assertExactCodexAppServerPlatformTuple({
    ...CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
    containmentProfile: "strict-linux-cgroup-v2",
  }), /tuple.*profile/u);
});

test("accepts the two real initialize observations without pinning patch or build text", () => {
  validateCodexAppServerUserAgent(linuxUserAgent, CODEX_APP_SERVER_LINUX_X64_TUPLE);
  validateCodexAppServerUserAgent(darwinUserAgent, CODEX_APP_SERVER_DARWIN_ARM64_TUPLE);
  validateCodexAppServerUserAgent(
    "agent-runtime/0.150.1 (Ubuntu 26.10; x86_64) release.7 (agent-runtime; codex-app-server-contained-turn:0.150.1)",
    CODEX_APP_SERVER_LINUX_X64_TUPLE,
  );
  validateCodexInitializeEvidence({
    codexHome: boundary.codexHome,
    platformFamily: "unix",
    platformOs: "macos",
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
    linuxUserAgent.replace("codex-app-server-contained-turn:0.150.1", "codex-app-server-contained-turn:other"),
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
  const linux = new CodexAppServerCurrentKernelAdapter({ attempts, platformTuple: CODEX_APP_SERVER_LINUX_X64_TUPLE });
  const darwin = new CodexAppServerCurrentKernelAdapter({ attempts, platformTuple: CODEX_APP_SERVER_DARWIN_ARM64_TUPLE });
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
    const exactBoundary = createCodexAppServerPermissionBoundary({ codexHome, workspaceRef: workspace });
    const plan = createCodexAppServerLaunchPlan({
      boundary: exactBoundary,
      executablePath: "/synthetic/codex-darwin-arm64",
      intentMode: "analysis",
      platformTuple: CODEX_APP_SERVER_DARWIN_ARM64_TUPLE,
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
