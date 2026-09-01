import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD,
  claudeAgentSdkArguments,
  createClaudeAgentSdkLaunchPlan,
  createClaudeAgentSdkPrivateProjection,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { createCodexAppServerLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
const privateDirectoryCustody = Object.freeze({
  async assertPrivateDirectory(path: string): Promise<void> {
    const observation = await lstat(path);
    assert.equal(observation.isDirectory(), true);
    assert.equal(observation.isSymbolicLink(), false);
  },
});

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar-provider-launch-authority-")));
  const workspaceRef = join(root, "workspace");
  const privateRootPath = `${workspaceRef}-host-private`;
  const codexHome = join(privateRootPath, "codex-home");
  const codexTmp = join(privateRootPath, "codex-tmp");
  const claudeConfig = join(privateRootPath, "claude-config");
  const claudeHome = join(privateRootPath, "claude-home");
  const claudeTmp = join(privateRootPath, "claude-tmp");
  mkdirSync(workspaceRef, { mode: 0o700 });
  for (const path of [codexHome, codexTmp, claudeConfig, claudeHome, claudeTmp]) {
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  const boundary = createCodexAppServerPermissionBoundary({ codexHome, workspaceRef });
  const privateProjection = createClaudeAgentSdkPrivateProjection({
    configRoot: claudeConfig,
    homeRoot: claudeHome,
    projectionRef: "projection:provider-launch-authority",
    tempRoot: claudeTmp,
    workspaceRef,
  });
  return { boundary, codexTmp, privateProjection, privateRootPath, root, workspaceRef };
};

test("provider launch plans bind exact caller-owned root and requested mode without eager or widened authority", async t => {
  const value = fixture();
  t.after(() => {rmSync(value.root, { force: true, recursive: true });});

  for (const intentMode of ["analysis", "workspace-write"] as const) {
    const codex = createCodexAppServerLaunchPlan({
      boundary: value.boundary,
      executablePath: "/synthetic/codex",
      intentMode,
      platformTarget: {architecture: "x64", platform: "linux"},
      privateRootPath: value.privateRootPath,
      tmpDir: value.codexTmp,
    });
    assert.equal(codex.intentMode, intentMode);
    assert.equal(codex.privateRootPath, value.privateRootPath);
    assert.equal(codex.spawnMode, "sdk-delegated");
    assert.equal(Object.isFrozen(codex), true);

    const claude = await createClaudeAgentSdkLaunchPlan({
      binaryRevision: "@anthropic-ai/claude-agent-sdk:0.3.251+synthetic",
      executablePath: "/synthetic/claude",
      executableSha256: "0".repeat(64),
      intentMode,
      privateProjection: value.privateProjection,
      privateDirectoryCustody,
      privateRootPath: value.privateRootPath,
      workspaceRef: value.workspaceRef,
    });
    assert.equal(claude.intentMode, intentMode);
    assert.equal(claude.privateRootPath, value.privateRootPath);
    assert.equal(claude.spawnMode, "sdk-delegated");
    assert.equal(claude.environment, value.privateProjection.environment);
    assert.deepEqual(claude.arguments, claudeAgentSdkArguments(intentMode, CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD));
    assert.equal("delegatedArgumentVariants" in claude, false);
    const settingsIndex = claude.arguments.indexOf("--settings");
    const settings = JSON.parse(claude.arguments[settingsIndex + 1] ?? "null") as {
      sandbox: { filesystem: { allowWrite: string[] } };
    };
    assert.deepEqual(settings.sandbox.filesystem.allowWrite, intentMode === "analysis" ? [] : [CLAUDE_AGENT_SDK_HOST_WORKSPACE_CWD]);
  }
});

test("provider launch plan factories fail closed for missing or invalid trusted authority inputs", async t => {
  const value = fixture();
  t.after(() => {rmSync(value.root, { force: true, recursive: true });});
  const codexBase = {
    boundary: value.boundary,
    executablePath: "/synthetic/codex",
    intentMode: "analysis" as const,
    platformTarget: {architecture: "x64" as const, platform: "linux" as const},
    privateRootPath: value.privateRootPath,
    tmpDir: value.codexTmp,
  };
  assert.throws(() => createCodexAppServerLaunchPlan({
    ...codexBase, platformTarget: undefined,
  } as never), /No exact/u);
  assert.throws(() => createCodexAppServerLaunchPlan({ ...codexBase, intentMode: undefined } as never), /intentMode/u);
  assert.throws(() => createCodexAppServerLaunchPlan({ ...codexBase, privateRootPath: undefined } as never), /privateRootPath/u);
  assert.throws(() => createCodexAppServerLaunchPlan({ ...codexBase, privateRootPath: value.workspaceRef }), /disjoint/u);

  const claudeBase = {
    binaryRevision: "@anthropic-ai/claude-agent-sdk:0.3.251+synthetic",
    executablePath: "/synthetic/claude",
    executableSha256: "0".repeat(64),
    intentMode: "analysis" as const,
    privateDirectoryCustody,
    privateProjection: value.privateProjection,
    privateRootPath: value.privateRootPath,
    workspaceRef: value.workspaceRef,
  };
  await assert.rejects(createClaudeAgentSdkLaunchPlan({ ...claudeBase, intentMode: undefined } as never), /intentMode/u);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({ ...claudeBase, privateRootPath: undefined } as never), /privateRootPath/u);
  await assert.rejects(createClaudeAgentSdkLaunchPlan({ ...claudeBase, privateRootPath: value.workspaceRef }), /disjoint/u);
});
