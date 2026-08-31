import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { HostCustodyLaunchPlan } from "../host-custody/custodied-provider-process.js";
import {
  CODEX_APP_SERVER_BINARY_REVISION,
  CODEX_APP_SERVER_BINARY_SHA256,
  CODEX_PERMISSION_PROFILE_ID,
  canonicalCodexJson,
  validateCodexDirectoryIdentity,
  type CodexAppServerPermissionBoundary,
  type CodexDirectoryIdentity,
} from "./codex-app-server-permission-boundary.js";

const DISABLED_CODEX_FEATURES = Object.freeze([
  "apps",
  "browser_use",
  "computer_use",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
] as const);

export interface CodexAppServerLaunchPlanOptions {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly executablePath: string;
  readonly tmpDir: string;
}

export interface CodexAppServerLaunchPlan extends HostCustodyLaunchPlan {
  readonly codexHome: string;
  readonly codexHomeIdentity: CodexDirectoryIdentity;
  readonly effectivePolicyDigest: string;
  readonly permissionProfileId: typeof CODEX_PERMISSION_PROFILE_ID;
  readonly tmpDir: string;
  readonly tmpDirIdentity: CodexDirectoryIdentity;
  readonly workspaceRef: string;
  readonly workspaceIdentity: CodexDirectoryIdentity;
}

const contains = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const privateTmpIdentity = (value: string): CodexDirectoryIdentity => {
  if (!isAbsolute(value) || resolve(value) !== value || value === "/") {
    throw new TypeError("tmpDir must be a normalized absolute non-root path");
  }
  const link = lstatSync(value);
  if (!link.isDirectory() || link.isSymbolicLink() || realpathSync(value) !== value) {
    throw new TypeError("tmpDir must be a canonical non-symlink directory");
  }
  const directory = statSync(value);
  if (typeof process.getuid !== "function" || directory.uid !== process.getuid()
    || (directory.mode & 0o077) !== 0) {
    throw new TypeError("tmpDir must be current-user-owned with mode 0700 or more restrictive");
  }
  return Object.freeze({ device: directory.dev, inode: directory.ino, path: value });
};

const isDirectoryIdentity = (value: unknown): value is CodexDirectoryIdentity =>
  typeof value === "object" && value !== null
  && typeof (value as Partial<CodexDirectoryIdentity>).device === "number"
  && typeof (value as Partial<CodexDirectoryIdentity>).inode === "number"
  && typeof (value as Partial<CodexDirectoryIdentity>).path === "string";

export const validateCodexAppServerLaunchPlanRoots = (
  plan: HostCustodyLaunchPlan,
): void => {
  if (!("codexHome" in plan) || typeof plan.codexHome !== "string"
    || !("tmpDir" in plan) || typeof plan.tmpDir !== "string"
    || !("workspaceRef" in plan) || typeof plan.workspaceRef !== "string"
    || !("codexHomeIdentity" in plan) || !isDirectoryIdentity(plan.codexHomeIdentity)
    || !("tmpDirIdentity" in plan) || !isDirectoryIdentity(plan.tmpDirIdentity)
    || !("workspaceIdentity" in plan) || !isDirectoryIdentity(plan.workspaceIdentity)
    || plan.codexHomeIdentity.path !== plan.codexHome
    || plan.tmpDirIdentity.path !== plan.tmpDir
    || plan.workspaceIdentity.path !== plan.workspaceRef) {
    throw new TypeError("exact Codex App Server launch plan is missing canonical root identities");
  }
  validateCodexDirectoryIdentity("codexHome", plan.codexHomeIdentity);
  validateCodexDirectoryIdentity("tmpDir", plan.tmpDirIdentity);
  validateCodexDirectoryIdentity("workspaceRef", plan.workspaceIdentity, false);
  const exactEnvironment = {
    CODEX_HOME: plan.codexHome,
    HOME: plan.codexHome,
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: plan.tmpDir,
  };
  if (canonicalCodexJson(plan.environment) !== canonicalCodexJson(exactEnvironment)) {
    throw new TypeError("exact Codex App Server launch environment does not match the validated roots");
  }
};

export const createCodexAppServerLaunchPlan = (
  options: CodexAppServerLaunchPlanOptions,
): CodexAppServerLaunchPlan => {
  validateCodexDirectoryIdentity("codexHome", options.boundary.codexHomeIdentity);
  validateCodexDirectoryIdentity("workspaceRef", options.boundary.workspaceIdentity, false);
  const tmpDirIdentity = privateTmpIdentity(options.tmpDir);
  const roots = [options.boundary.workspaceRef, options.boundary.codexHome, options.tmpDir] as const;
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (contains(roots[left]!, roots[right]!) || contains(roots[right]!, roots[left]!)) {
        throw new TypeError("Codex workspace, private home, and TMPDIR must be pairwise disjoint");
      }
    }
  }
  const launchArguments = [
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    `default_permissions=${JSON.stringify(CODEX_PERMISSION_PROFILE_ID)}`,
  ];
  for (const feature of DISABLED_CODEX_FEATURES) {launchArguments.push("--disable", feature);}
  return Object.freeze({
    arguments: Object.freeze(launchArguments),
    binaryRevision: CODEX_APP_SERVER_BINARY_REVISION,
    codexHome: options.boundary.codexHome,
    codexHomeIdentity: options.boundary.codexHomeIdentity,
    containmentProfile: "cooperative-posix",
    effectivePolicyDigest: options.boundary.effectivePolicyDigest,
    environment: Object.freeze({
      CODEX_HOME: options.boundary.codexHome,
      HOME: options.boundary.codexHome,
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: options.tmpDir,
    }),
    executablePath: options.executablePath,
    executableSha256: CODEX_APP_SERVER_BINARY_SHA256,
    permissionProfileId: CODEX_PERMISSION_PROFILE_ID,
    provider: "codex",
    tmpDir: options.tmpDir,
    tmpDirIdentity,
    workspaceRef: options.boundary.workspaceRef,
    workspaceIdentity: options.boundary.workspaceIdentity,
  });
};
