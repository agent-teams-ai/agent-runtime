import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ContainedTurnWorkspacePort } from "../legacy/legacy-contained-turn-ports.js";
import type { ContainedTurnKernelWorkspacePort } from "../../../application/ports/outbound/contained-turn-ports.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import {
  assertPrivateDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  isMissingFilesystemEntry,
} from "./contained-turn-filesystem-custody.js";
import {
  DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS,
  scanContainedTurnWorkspace,
  type ContainedTurnWorkspaceTreeLimits,
} from "./contained-turn-workspace-tree.js";

export interface NodeContainedTurnWorkspaceOptions {
  readonly limits?: ContainedTurnWorkspaceTreeLimits;
  readonly root: string;
}

const workspaceName = (operationId: string): string =>
  `operation-${createHash("sha256").update(operationId).digest("hex")}`;

const assertWorkspaceRef = (workspaceRef: string, activeRoot: string): string => {
  if (!isAbsolute(workspaceRef) || resolve(workspaceRef) !== workspaceRef || dirname(workspaceRef) !== activeRoot) {
    throw new Error("contained turn workspace reference is outside active custody");
  }
  if (!/^operation-[a-f\d]{64}$/u.test(basename(workspaceRef))) {
    throw new Error("contained turn workspace reference has an invalid identity");
  }
  return basename(workspaceRef);
};

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFilesystemEntry(error)) {return false;}
    throw error;
  }
};

export const createNodeContainedTurnWorkspace = async (
  options: NodeContainedTurnWorkspaceOptions,
): Promise<ContainedTurnWorkspacePort & Pick<ContainedTurnKernelWorkspacePort, "ensureClosed" | "queryClosure">> => {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root) {
    throw new TypeError("contained turn workspace custody root must be a normalized absolute path");
  }
  const limits = options.limits ?? DEFAULT_CONTAINED_TURN_WORKSPACE_LIMITS;
  const custodyRoot = await ensurePrivateDirectory(options.root);
  const activeRoot = join(custodyRoot, "active");
  const closedRoot = join(custodyRoot, "closed");
  const quarantineRoot = join(custodyRoot, "quarantine");
  await Promise.all([
    ensurePrivateDirectory(activeRoot),
    ensurePrivateDirectory(closedRoot),
    ensurePrivateDirectory(quarantineRoot),
  ]);

  const closureOutcome = async (input: Parameters<ContainedTurnKernelWorkspacePort["ensureClosed"]>[0], closeWorkspace: boolean) => {
    const workspaceRef = input.workspaceId.startsWith("workspace:")
      ? input.workspaceId.slice("workspace:".length)
      : input.workspaceId;
    const name = assertWorkspaceRef(workspaceRef, activeRoot);
    const closedPath = join(closedRoot, name);
    const activeExists = await directoryExists(workspaceRef);
    const closedExists = await directoryExists(closedPath);
    if (activeExists && closedExists) {throw new Error("contained turn workspace has conflicting active and closed custody");}
    if (!activeExists && !closedExists) {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:workspace-closure:${digestContainedTurnCanonicalValue({ operationId: input.operationId, requestDigest: input.requestDigest })}`),
        kind: "indeterminate" as const,
      });
    }
    if (activeExists && !closeWorkspace) {
      return Object.freeze({
        evidenceId: containedTurnIdentity("evidence", `evidence:workspace-closure-pending:${digestContainedTurnCanonicalValue({ operationId: input.operationId, requestDigest: input.requestDigest })}`),
        kind: "indeterminate" as const,
      });
    }
    if (activeExists) {
      await scanContainedTurnWorkspace(workspaceRef, limits);
      await rename(workspaceRef, closedPath);
      await fsyncDirectory(activeRoot);
      await fsyncDirectory(closedRoot);
    }
    return Object.freeze({
      kind: "proved" as const,
      proof: Object.freeze({
        binding: Object.freeze({
          authorityVectorDigest: input.authorityVectorDigest,
          operationId: input.operationId,
          workspaceId: input.workspaceId,
        }),
        kind: "workspace_closure" as const,
        proofId: containedTurnIdentity("proof", `proof:workspace-closure:${input.requestDigest}`),
      }),
      requestDigest: input.requestDigest,
      requestId: input.requestId,
    });
  };
  const adapter: ContainedTurnWorkspacePort & Pick<ContainedTurnKernelWorkspacePort, "ensureClosed" | "queryClosure"> = {
    ensureClosed: input => closureOutcome(input, true),
    queryClosure: input => closureOutcome(input, false),
    async close(workspaceRef) {
      const name = assertWorkspaceRef(workspaceRef, activeRoot);
      const closedPath = join(closedRoot, name);
      const activeExists = await directoryExists(workspaceRef);
      const closedExists = await directoryExists(closedPath);
      if (activeExists && closedExists) {throw new Error("contained turn workspace has conflicting active and closed custody");}
      const tree = await scanContainedTurnWorkspace(activeExists ? workspaceRef : closedPath, limits);
      if (activeExists) {
        await rename(workspaceRef, closedPath);
        await fsyncDirectory(activeRoot);
        await fsyncDirectory(closedRoot);
      }
      return {
        receiptRef: `urn:agent-runtime:workspace-closed:${createHash("sha256").update(`${name}:${tree.treeDigest}`).digest("hex")}`,
      };
    },
    async create(input) {
      const name = workspaceName(input.operationId);
      const activePath = join(activeRoot, name);
      if (await directoryExists(join(closedRoot, name))) {
        throw new Error("contained turn workspace is already closed and cannot be reopened");
      }
      try {
        await mkdir(activePath, { mode: 0o700 });
        await fsyncDirectory(activeRoot);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {throw error;}
      }
      await assertPrivateDirectory(activePath);
      return { workspaceRef: activePath };
    },
    async quarantine(input) {
      const name = assertWorkspaceRef(input.workspaceRef, activeRoot);
      const suffix = createHash("sha256").update(input.evidenceRef).digest("hex");
      const quarantinePath = join(quarantineRoot, `${name}-${suffix}`);
      if (await directoryExists(input.workspaceRef)) {
        if (await directoryExists(quarantinePath)) {
          throw new Error("contained turn workspace has conflicting active and quarantined custody");
        }
        await rename(input.workspaceRef, quarantinePath);
        await fsyncDirectory(activeRoot);
        await fsyncDirectory(quarantineRoot);
        return;
      }
      const existing = (await readdir(quarantineRoot)).filter(candidate => candidate.startsWith(`${name}-`));
      if (existing.length !== 1 || existing[0] !== basename(quarantinePath)) {
        throw new Error("contained turn workspace quarantine outcome is ambiguous");
      }
    },
  };
  return Object.freeze(adapter);
};
