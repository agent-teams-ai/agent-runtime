import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const CAMPAIGN_PREFIX = "agent-runtime-filesystem-contained-turn-";
const trackedCampaignRoots = new Set<string>();

export interface SyntheticWorkspaceOptions {
  readonly canonicalProjectRoot: string;
  readonly disposableRoot: string;
  readonly root: string;
}

export interface SyntheticArtifactOptions extends SyntheticWorkspaceOptions {
  readonly rehydrationRoot: string;
  readonly workspaceRoot: string;
}

export interface SyntheticFilesystemLayout {
  readonly artifactOptions: SyntheticArtifactOptions;
  readonly artifactRoot: string;
  readonly campaignRoot: string;
  readonly canonicalProjectRoot: string;
  readonly cleanup: () => Promise<void>;
  readonly disposableRoot: string;
  readonly rehydrationRoot: string;
  readonly workspaceOptions: SyntheticWorkspaceOptions;
  readonly workspaceRoot: string;
}

const assertTrackedCampaignRoot = (campaignRoot: string): void => {
  const expectedParent = resolve(tmpdir());
  if (
    dirname(campaignRoot) !== expectedParent ||
    !basename(campaignRoot).startsWith(CAMPAIGN_PREFIX)
  ) {
    throw new Error("refusing to clean an untracked filesystem test campaign");
  }
};

const cleanupCampaignRoot = async (campaignRoot: string): Promise<void> => {
  assertTrackedCampaignRoot(campaignRoot);
  await rm(campaignRoot, { force: true, recursive: true });
  trackedCampaignRoots.delete(campaignRoot);
};

export const cleanupTrackedFilesystemLayouts = async (): Promise<void> => {
  await Promise.all([...trackedCampaignRoots].map(cleanupCampaignRoot));
};

export const createSyntheticFilesystemLayout = async (): Promise<SyntheticFilesystemLayout> => {
  const campaignRoot = await mkdtemp(join(resolve(tmpdir()), CAMPAIGN_PREFIX));
  trackedCampaignRoots.add(campaignRoot);

  try {
    await chmod(campaignRoot, 0o700);
    const canonicalProjectRoot = join(campaignRoot, "canonical-project");
    const disposableRoot = join(campaignRoot, "disposable");
    await Promise.all([
      mkdir(canonicalProjectRoot, { mode: 0o700 }),
      mkdir(disposableRoot, { mode: 0o700 }),
    ]);

    const workspaceRoot = join(disposableRoot, "workspaces");
    const artifactRoot = join(disposableRoot, "artifacts");
    const rehydrationRoot = join(disposableRoot, "rehydration");
    await Promise.all([
      mkdir(workspaceRoot, { mode: 0o700 }),
      mkdir(artifactRoot, { mode: 0o700 }),
      mkdir(rehydrationRoot, { mode: 0o700 }),
    ]);

    const workspaceOptions = Object.freeze({
      canonicalProjectRoot,
      disposableRoot,
      root: workspaceRoot,
    });
    const artifactOptions = Object.freeze({
      canonicalProjectRoot,
      disposableRoot,
      rehydrationRoot,
      root: artifactRoot,
      workspaceRoot,
    });
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) {
        return;
      }
      await cleanupCampaignRoot(campaignRoot);
      cleaned = true;
    };

    return Object.freeze({
      artifactOptions,
      artifactRoot,
      campaignRoot,
      canonicalProjectRoot,
      cleanup,
      disposableRoot,
      rehydrationRoot,
      workspaceOptions,
      workspaceRoot,
    });
  } catch (error) {
    await cleanupCampaignRoot(campaignRoot);
    throw error;
  }
};

export interface DeterministicFaultInjector {
  arm(point: string, error: unknown): void;
  checkpoint(point: string): Promise<void> | void;
  readonly checkpoints: readonly string[];
}

export const createDeterministicFaultInjector = (): DeterministicFaultInjector => {
  const armed = new Map<string, unknown[]>();
  const observedCheckpoints: string[] = [];

  return Object.freeze({
    arm(point: string, error: unknown): void {
      const errors = armed.get(point) ?? [];
      errors.push(error);
      armed.set(point, errors);
    },
    checkpoint(point: string): void {
      observedCheckpoints.push(point);
      const errors = armed.get(point);
      if (errors === undefined || errors.length === 0) {
        return;
      }
      const error = errors.shift();
      if (errors.length === 0) {
        armed.delete(point);
      }
      throw error;
    },
    get checkpoints(): readonly string[] {
      return Object.freeze([...observedCheckpoints]);
    },
  });
};

export type DigestBytes = string | Uint8Array;
export type DomainDigest = (domain: string, bytes: DigestBytes) => string;

export const createDomainSelectiveFakeDigest = (
  selectedDomains: string | readonly string[],
  forcedDigest = "f".repeat(64),
): DomainDigest => {
  if (!/^[a-f\d]{64}$/u.test(forcedDigest)) {
    throw new TypeError("forced digest must be a lowercase SHA-256-shaped value");
  }
  const domains = new Set(
    typeof selectedDomains === "string" ? [selectedDomains] : selectedDomains,
  );
  return (domain, bytes) =>
    domains.has(domain)
      ? forcedDigest
      : createHash("sha256").update(bytes).digest("hex");
};

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const portableRelativePath = (root: string, path: string): string =>
  relative(root, path).split(sep).join("/");

export const listRelativeResidue = async (root: string): Promise<readonly string[]> => {
  const residue: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      residue.push(portableRelativePath(root, path));
      if (entry.isDirectory()) {
        await visit(path);
      }
    }
  };

  try {
    await visit(root);
  } catch (error) {
    if (isMissing(error)) {
      return Object.freeze([]);
    }
    throw error;
  }
  return Object.freeze(residue.toSorted());
};

export const assertNoTemporaryResidue = async (root: string): Promise<void> => {
  const residue = await listRelativeResidue(root);
  const temporary = residue.filter(path => /(?:^|\/)[^/]*\.tmp$/u.test(path));
  assert.deepEqual(temporary, [], `temporary filesystem residue remained under ${root}`);
};
