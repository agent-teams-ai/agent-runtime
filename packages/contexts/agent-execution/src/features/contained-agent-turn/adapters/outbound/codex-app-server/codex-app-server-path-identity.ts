import { lstatSync, readdirSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";

const WINDOWS_RESERVED_NAME = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/iu;

const pathKey = (segment: string): string =>
  segment.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");

const portableSegment = (segment: string): boolean =>
  segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\u0000")
  && segment === segment.normalize("NFC") && !/[ .]$/u.test(segment) && !WINDOWS_RESERVED_NAME.test(segment)
  && ![".", ".."].includes(pathKey(segment)) && !/[\\/]/u.test(pathKey(segment));

const missingPath = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

type PathKind = "directory" | "file";

interface ExistingPathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly kind: PathKind;
  readonly path: string;
}

/** Untrusted provider endpoint observation. It is diagnostic only and never a custody or effect receipt. */
export interface CodexEndpointPathObservation {
  readonly authority: "provider-observation-only";
  readonly existing: readonly ExistingPathIdentity[];
  /** A missing suffix has no inode. It may materialize, but is recaptured before later reconciliation. */
  readonly firstMissingPath?: string;
  readonly path: string;
}

export interface ObservedCodexWorkspaceEndpoint {
  readonly endpointObservation: CodexEndpointPathObservation;
  readonly path: string;
}

const normalizedEndpointCandidate = (value: string, workspaceRef: string): string => {
  if (value.length === 0 || value.includes("\\") || value.includes("\u0000") || value !== value.normalize("NFC")) {
    throw new TypeError("Codex provider endpoint is not a normalized pinned-candidate platform path");
  }
  if (isAbsolute(value) && resolve(value) !== value) {
    throw new TypeError("Codex provider path is not a normalized absolute path");
  }
  if (!isAbsolute(value) && !value.split("/").every(portableSegment)) {
    throw new TypeError("Codex provider path contains an ambiguous relative segment");
  }
  return isAbsolute(value) ? value : resolve(workspaceRef, value);
};

const containedEndpointSuffix = (candidate: string, workspaceRef: string, allowWorkspaceRoot: boolean): string => {
  const suffix = relative(workspaceRef, candidate);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    || (suffix === "" && !allowWorkspaceRoot)
    || (suffix !== "" && !suffix.split(sep).every(portableSegment))) {
    throw new TypeError("Codex provider path escaped disposable workspace custody");
  }
  return suffix;
};

const kindOf = (observation: BigIntStats): PathKind => {
  if (observation.isDirectory()) {return "directory";}
  if (observation.isFile()) {return "file";}
  throw new TypeError("Codex provider path has an unsupported filesystem type");
};

const assertDirectoryEntriesUnambiguous = (path: string): Map<string, string> => {
  const folded = new Map<string, string>();
  for (const name of readdirSync(path)) {
    if (!portableSegment(name)) {throw new TypeError("Codex workspace contains a non-portable path entry");}
    const key = pathKey(name);
    const prior = folded.get(key);
    if (prior !== undefined && prior !== name) {
      throw new TypeError("Codex workspace contains a case or Unicode path collision");
    }
    folded.set(key, name);
  }
  return folded;
};

const captureExisting = (
  path: string,
  boundary: CodexAppServerPermissionBoundary,
): ExistingPathIdentity => {
  const observation = lstatSync(path, { bigint: true });
  if (observation.isSymbolicLink() || realpathSync(path) !== path) {
    throw new TypeError("Codex provider path has symlink-like ambiguity");
  }
  if (observation.dev !== BigInt(boundary.workspaceIdentity.device)) {
    throw new TypeError("Codex provider path identity crossed the disposable workspace device boundary");
  }
  if (path === boundary.workspaceRef
    && (observation.dev !== BigInt(boundary.workspaceIdentity.device)
      || observation.ino !== BigInt(boundary.workspaceIdentity.inode))) {
    throw new TypeError("Codex workspace identity changed after permission-boundary admission");
  }
  const kind = kindOf(observation);
  if (kind === "file" && observation.nlink !== 1n) {
    throw new TypeError("Codex provider path has hardlink ambiguity");
  }
  return Object.freeze({ device: observation.dev, inode: observation.ino, kind, path });
};

const captureEndpointObservation = (
  candidate: string,
  suffix: string,
  boundary: CodexAppServerPermissionBoundary,
): CodexEndpointPathObservation => {
  const existing: ExistingPathIdentity[] = [captureExisting(boundary.workspaceRef, boundary)];
  let parent = boundary.workspaceRef;
  let firstMissingPath: string | undefined;
  const segments = suffix === "" ? [] : suffix.split(sep);
  for (const [index, segment] of segments.entries()) {
    const entries = assertDirectoryEntriesUnambiguous(parent);
    const alias = entries.get(pathKey(segment));
    if (alias !== undefined && alias !== segment) {
      throw new TypeError("Codex provider path has case or Unicode ambiguity");
    }
    const path = join(parent, segment);
    try {
      const identity = captureExisting(path, boundary);
      if (index < segments.length - 1 && identity.kind !== "directory") {
        throw new TypeError("Codex provider path crosses a non-directory ancestor");
      }
      existing.push(identity);
      parent = path;
    } catch (error) {
      if (!missingPath(error)) {throw error;}
      firstMissingPath = path;
      break;
    }
  }
  return Object.freeze({ authority: "provider-observation-only", existing: Object.freeze(existing),
    ...(firstMissingPath === undefined ? {} : { firstMissingPath }), path: candidate });
};

export const observeCodexWorkspaceEndpoint = (
  value: string,
  boundary: CodexAppServerPermissionBoundary,
  allowWorkspaceRoot = false,
): ObservedCodexWorkspaceEndpoint => {
  if (boundary.workspaceIdentity.path !== boundary.workspaceRef) {
    throw new TypeError("Codex workspace path does not match its validated filesystem identity");
  }
  const candidate = normalizedEndpointCandidate(value, boundary.workspaceRef);
  const suffix = containedEndpointSuffix(candidate, boundary.workspaceRef, allowWorkspaceRoot);
  return Object.freeze({ endpointObservation: captureEndpointObservation(candidate, suffix, boundary), path: candidate });
};

export const diagnoseCodexWorkspaceEndpoint = (
  endpointObservation: CodexEndpointPathObservation,
  boundary: CodexAppServerPermissionBoundary,
): void => {
  const current = observeCodexWorkspaceEndpoint(endpointObservation.path, boundary,
    endpointObservation.path === boundary.workspaceRef).endpointObservation;
  if (current.existing.length < endpointObservation.existing.length) {
    throw new TypeError("Codex provider endpoint observation disappeared after admission");
  }
  if (current.firstMissingPath !== endpointObservation.firstMissingPath) {
    throw new TypeError("Codex provider endpoint missing/new observation changed after admission");
  }
  for (const [index, admitted] of endpointObservation.existing.entries()) {
    const observed = current.existing[index];
    if (observed === undefined || observed.path !== admitted.path || observed.device !== admitted.device
      || observed.inode !== admitted.inode || observed.kind !== admitted.kind) {
      throw new TypeError("Codex provider endpoint observation changed after admission");
    }
  }
};
