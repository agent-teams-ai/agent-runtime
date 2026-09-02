import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTITY = /^[a-zA-Z0-9@._:+/;-]{1,192}$/u;
const VERIFIED_EXECUTION = Symbol("verified candidate canary execution");
const executionAuthorities = new WeakMap();
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const MAX_BUILD_FILES = 25_000;
const MAX_BUILD_BYTES = 256 * 1024 * 1024;
const gitEnvironment = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

const sha256 = value => createHash("sha256").update(value).digest("hex");

const git = async (root, args, encoding = "utf8") => {
  try {
    const result = await execFileAsync("/usr/bin/git", [
      "-c", "core.excludesFile=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.untrackedCache=false",
      "-C", root, ...args,
    ], {
      encoding,
      env: gitEnvironment,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    throw new Error("canary execution provenance is unavailable");
  }
};

const exactSourceSha = value => {
  const sourceSha = value.trim();
  if (!SOURCE_SHA.test(sourceSha)) { throw new TypeError("canary source SHA must be exact"); }
  return sourceSha;
};

const safeIdentity = (value, label) => {
  if (typeof value !== "string" || !SAFE_IDENTITY.test(value)) {
    throw new TypeError(`${label} must be a bounded identity`);
  }
  return value;
};

const exactDigest = (digest, label) => {
  if (!SHA256.test(digest)) { throw new TypeError(`${label} must be exact`); }
  return `sha256:${digest}`;
};

const repositoryRelativeFile = async (repositoryRoot, sourceUrl, sourceSha) => {
  const sourcePath = fileURLToPath(sourceUrl);
  const entry = await lstat(sourcePath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("canary implementation is not a regular source file");
  }
  const canonicalSourcePath = await realpath(sourcePath);
  const repositoryPath = relative(repositoryRoot, canonicalSourcePath);
  if (repositoryPath === "" || repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) {
    throw new Error("executed canary implementation is absent from source commit");
  }
  const committedSource = await git(repositoryRoot, ["show", `${sourceSha}:${repositoryPath}`], null);
  const executedSource = await readFile(canonicalSourcePath);
  if (!Buffer.from(committedSource).equals(executedSource)) {
    throw new Error("executed canary implementation does not match source commit");
  }
  return Object.freeze({ digest: sha256(executedSource), repositoryPath });
};

const digestBuildTree = async buildRootUrl => {
  const rootPath = fileURLToPath(buildRootUrl);
  const rootEntry = await lstat(rootPath);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("candidate build root is not a regular directory");
  }
  const canonicalRoot = await realpath(rootPath);
  const files = [];
  const visit = async (directory, prefix) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const repositoryPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) { throw new Error("candidate build tree contains a symbolic link"); }
      if (entry.isDirectory()) { await visit(path, repositoryPath); continue; }
      if (!entry.isFile()) { throw new Error("candidate build tree contains a non-regular entry"); }
      files.push(Object.freeze({ path, repositoryPath }));
      if (files.length > MAX_BUILD_FILES) { throw new Error("candidate build tree exceeds file limit"); }
    }
  };
  await visit(canonicalRoot, "");
  if (files.length === 0) { throw new Error("candidate build tree is empty"); }
  let bytes = 0;
  const digest = createHash("sha256");
  for (const file of files) {
    const content = await readFile(file.path);
    bytes += content.byteLength;
    if (bytes > MAX_BUILD_BYTES) { throw new Error("candidate build tree exceeds byte limit"); }
    digest.update(`${file.repositoryPath}\0${content.byteLength}\0`);
    digest.update(content);
  }
  return Object.freeze({ bytes, digest: digest.digest("hex"), files: files.length });
};

export const resolveCanaryExecutionProvenance = async input => {
  const provider = safeIdentity(input.provider, "canary provider");
  const canaryId = safeIdentity(input.canaryId, "canary ID");
  const authorityPath = fileURLToPath(import.meta.url);
  const repositoryRoot = await realpath((await git(dirname(authorityPath), ["rev-parse", "--show-toplevel"])).trim());
  const sourceSha = exactSourceSha(await git(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
  if (exactSourceSha(input.claimedSourceSha) !== sourceSha) {
    throw new Error("canary source SHA does not match executed checkout");
  }
  const status = await git(repositoryRoot, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
  ]);
  if (status.length !== 0) { throw new Error("canary source checkout is dirty"); }
  const [authority, canary, build] = await Promise.all([
    repositoryRelativeFile(repositoryRoot, import.meta.url, sourceSha),
    repositoryRelativeFile(repositoryRoot, input.canarySourceUrl, sourceSha),
    digestBuildTree(input.buildRootUrl),
  ]);
  const tokenDigest = sha256(JSON.stringify({
    authorityDigest: authority.digest,
    buildDigest: build.digest,
    canaryDigest: canary.digest,
    canaryId,
    provider,
    sourceSha,
  }));
  const execution = Object.freeze({
    [VERIFIED_EXECUTION]: true,
    build: Object.freeze({ bytes: build.bytes, files: build.files, treeDigest: build.digest }),
    canary: Object.freeze({ id: canaryId, sourceDigest: canary.digest }),
    provider,
    sourceSha,
    tokenDigest,
  });
  executionAuthorities.set(execution, Object.freeze({
    authoritySourceUrl: import.meta.url,
    buildRootUrl: input.buildRootUrl,
    canarySourceUrl: input.canarySourceUrl,
    repositoryRoot,
  }));
  return execution;
};

export const revalidateCanaryExecutionProvenance = async execution => {
  const authority = executionAuthorities.get(execution);
  if (execution?.[VERIFIED_EXECUTION] !== true || authority === undefined) {
    throw new TypeError("verified canary execution provenance is required");
  }
  const sourceSha = exactSourceSha(await git(authority.repositoryRoot, [
    "rev-parse", "--verify", "HEAD^{commit}",
  ]));
  if (sourceSha !== execution.sourceSha) { throw new Error("canary source HEAD changed during execution"); }
  const status = await git(authority.repositoryRoot, [
    "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
  ]);
  if (status.length !== 0) { throw new Error("canary source checkout changed during execution"); }
  const [authoritySource, canarySource, build] = await Promise.all([
    repositoryRelativeFile(authority.repositoryRoot, authority.authoritySourceUrl, sourceSha),
    repositoryRelativeFile(authority.repositoryRoot, authority.canarySourceUrl, sourceSha),
    digestBuildTree(authority.buildRootUrl),
  ]);
  if (authoritySource.digest !== sha256(await readFile(fileURLToPath(authority.authoritySourceUrl))) ||
      canarySource.digest !== execution.canary.sourceDigest || build.digest !== execution.build.treeDigest) {
    throw new Error("canary source or executed build changed during execution");
  }
  return execution;
};

const safePackageIdentity = value => {
  if (typeof value === "string") { return safeIdentity(value, "package identity"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("package identity must be bounded");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 4) { throw new TypeError("package identity must be bounded"); }
  return Object.freeze(Object.fromEntries(entries.map(([key, item]) => [
    safeIdentity(key, "package identity key"), safeIdentity(item, "package identity value"),
  ])));
};

const safeObservations = input => {
  const output = {};
  for (const key of ["containmentProofDigest", "errorDigest", "outputDigest"]) {
    if (input[key] !== undefined) { output[key] = exactDigest(input[key], key); }
  }
  if (input.outputEvents !== undefined) {
    if (!Number.isSafeInteger(input.outputEvents) || input.outputEvents < 0 || input.outputEvents > 100_000) {
      throw new TypeError("output event count must be bounded");
    }
    output.outputEvents = input.outputEvents;
  }
  return Object.freeze(output);
};

export const createProviderCandidateEvidenceEnvelope = async input => {
  const execution = await revalidateCanaryExecutionProvenance(input.executionProvenance);
  if (input.provider !== execution.provider || input.canaryId !== execution.canary.id) {
    throw new TypeError("canary execution provenance does not match provider and canary");
  }
  const darwin = input.platformTuple.platform === "darwin";
  return Object.freeze({
    ...safeObservations(input.observations),
    binaryIdentity: Object.freeze({
      digest: exactDigest(input.binarySha256, "canary binary digest"),
      revision: safeIdentity(input.binaryRevision, "binary revision"),
    }),
    buildIdentity: Object.freeze({
      bytes: execution.build.bytes,
      files: execution.build.files,
      treeDigest: exactDigest(execution.build.treeDigest, "candidate build tree digest"),
    }),
    canaryIdentity: Object.freeze({
      id: execution.canary.id,
      sourceDigest: exactDigest(execution.canary.sourceDigest, "canary source digest"),
      tokenDigest: exactDigest(execution.tokenDigest, "canary execution token digest"),
    }),
    compositeContainment: darwin ? "indeterminate" : input.compositeContainment,
    networkRouteEnforcement: "unqualified",
    packageIdentity: safePackageIdentity(input.packageIdentity),
    physicalContainment: darwin ? "indeterminate" : input.physicalContainment,
    platformTuple: Object.freeze({ ...input.platformTuple }),
    provider: execution.provider,
    qualification: "implementation-evidence-only",
    sourceSha: execution.sourceSha,
    status: input.status,
  });
};
