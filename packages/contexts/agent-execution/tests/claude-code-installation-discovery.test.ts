import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
  type ExecutableFileObserver,
} from "../dist/composition.js";
import {
  isExecutableByEffectiveIdentity,
  isSupportedExecutableAliasKind,
} from "../dist/features/runtime-installation-discovery/adapters/outbound/node-executable-file-observer.js";

const execFile = promisify(execFileCallback);
const packageRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path, { bigint: true });
  return `${observation.dev}:${observation.ino}:${observation.ctimeNs}:${observation.size}`;
};

const executableModeStats = (mode: bigint) => ({
  gid: 2000n,
  mode,
  uid: 1000n,
});

const collectTypeScriptSources = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? collectTypeScriptSources(path)
        : Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

const candidate = (
  displayPath: string,
  source: "explicit" | "known-location" | "path-entry",
  overrides: Record<string, unknown> = {},
) => ({
  absolutePath: `/authorized/${displayPath}`,
  authorizedFileIdentity: `authorized-${displayPath}`,
  candidateIdentity: `candidate:${source}:${displayPath}`,
  canonicalPath: `/canonical/${displayPath}`,
  custodyRoot: {
    absolutePath: "/authorized",
    canonicalPath: "/canonical",
  },
  displayPath,
  priorityRank: source === "explicit" ? 1 as const : source === "path-entry" ? 2 as const : 3 as const,
  required: source === "explicit",
  source,
  ...overrides,
});

const filesystemCandidate = async (
  _root: string,
  absolutePath: string,
  displayPath: string,
  required: boolean,
  source: "explicit" | "known-location" | "path-entry" = "explicit",
) => ({
  absolutePath,
  authorizedFileIdentity: await fileIdentity(absolutePath),
  candidateIdentity: `candidate:${source}:${absolutePath}`,
  canonicalPath: await realpath(absolutePath),
  custodyRoot: {
    absolutePath,
    canonicalPath: await realpath(absolutePath),
  },
  displayPath,
  priorityRank: source === "explicit" ? 1 as const : source === "path-entry" ? 2 as const : 3 as const,
  required,
  source,
});

test("orders explicit, PATH, and frozen known-location aliases deterministically", async () => {
  const identities = new Map([
    ["explicit-b", "shared"],
    ["path-b", "shared"],
    ["$HOME/.local/bin/claude", "shared"],
    ["$HOMEBREW/bin/claude", "shared"],
    ["$LOCAL/bin/claude", "shared"],
    ["explicit-a", "first"],
  ]);
  const observer: ExecutableFileObserver = {
    async observe({ authorizedFileIdentity }) {
      return {
        identity: identities.get(authorizedFileIdentity ?? "") ?? "unknown",
        kind: "found",
      };
    },
  };
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: observer,
  });
  const candidates = [
    candidate("$LOCAL/bin/claude", "known-location", { priorityRank: 5 }),
    candidate("path-b", "path-entry"),
    candidate("explicit-b", "explicit"),
    candidate("$HOMEBREW/bin/claude", "known-location", { priorityRank: 4 }),
    candidate("explicit-a", "explicit"),
    candidate("$HOME/.local/bin/claude", "known-location", { priorityRank: 3 }),
  ].map(item => ({ ...item, authorizedFileIdentity: item.displayPath }));

  const first = await feature.discoverClaudeCodeInstallations.execute({
    candidates,
    observationEpoch: "epoch-claude",
  });
  const second = await feature.discoverClaudeCodeInstallations.execute({
    candidates: candidates.toReversed(),
    observationEpoch: "epoch-claude",
  });

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.installations.map(installation =>
      installation.aliases.map(alias => alias.displayPath),
    ),
    [
      ["explicit-a"],
      [
        "explicit-b",
        "path-b",
        "$HOME/.local/bin/claude",
        "$HOMEBREW/bin/claude",
        "$LOCAL/bin/claude",
      ],
    ],
  );
  assert.ok(
    first.installations.every(
      installation =>
        installation.status === "found_unverified" &&
        installation.installationRef.startsWith("claude-code-installation:"),
    ),
  );
  assert.ok(
    first.installations.every(
      installation => !installation.installationRef.startsWith("codex-installation:"),
    ),
  );
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.installations));
  assert.ok(Object.isFrozen(first.installations[0]?.aliases));
});

test("uses authorized rank and identity while keeping simultaneous system labels distinct", async () => {
  const observed: string[] = [];
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ authorizedFileIdentity }) {
        observed.push(authorizedFileIdentity ?? "");
        return { identity: authorizedFileIdentity ?? "", kind: "found" };
      },
    },
  });
  const homebrew = candidate("$HOMEBREW/bin/claude", "known-location", {
    authorizedFileIdentity: "homebrew-file",
    candidateIdentity: "known:homebrew",
    priorityRank: 4,
  });
  const local = candidate("$LOCAL/bin/claude", "known-location", {
    authorizedFileIdentity: "local-file",
    candidateIdentity: "known:local",
    priorityRank: 5,
  });

  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [local, homebrew],
    observationEpoch: "epoch-system-locations",
  });

  assert.deepEqual(observed, ["homebrew-file", "local-file"]);
  assert.deepEqual(
    result.installations.map(installation => installation.aliases[0]?.displayPath),
    ["$HOMEBREW/bin/claude", "$LOCAL/bin/claude"],
  );
  assert.notEqual(
    result.installations[0]?.installationRef,
    result.installations[1]?.installationRef,
  );
});

test("deduplicates candidates and groups same-file symbolic aliases", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-alias-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = join(root, "claude-real");
  const alias = join(root, "claude");
  await writeFile(executable, "synthetic");
  await chmod(executable, 0o755);
  await symlink(executable, alias);
  const executableCandidate = await filesystemCandidate(
    root,
    executable,
    "$HOME/bin/claude-real",
    true,
  );
  const aliasCandidate = await filesystemCandidate(
    root,
    alias,
    "$HOME/bin/claude",
    false,
    "path-entry",
  );
  let observations = 0;
  const nodeObserver = createNodeExecutableFileObserver();
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(...arguments_) {
        observations += 1;
        return nodeObserver.observe(...arguments_);
      },
    },
  });

  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [aliasCandidate, executableCandidate, executableCandidate],
    observationEpoch: "epoch-alias",
  });

  assert.equal(observations, 2);
  assert.equal(result.installations.length, 1);
  assert.deepEqual(
    result.installations[0]?.aliases.map(item => item.displayPath),
    ["$HOME/bin/claude-real", "$HOME/bin/claude"],
  );
});

test("observes an approved alias and external executable with a file-level boundary", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-external-target-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const approved = join(root, "home", ".local", "bin");
  const external = join(root, "relocated-share", "versions", "2.1.205");
  const alias = join(approved, "claude");
  await Promise.all([
    mkdir(approved, { recursive: true }),
    mkdir(dirname(external), { recursive: true }),
  ]);
  await writeFile(external, "synthetic provider bytes");
  await chmod(external, 0o755);
  await symlink(external, alias);
  const authorized = await filesystemCandidate(
    approved,
    alias,
    "$HOME/.local/bin/claude",
    false,
    "known-location",
  );
  assert.deepEqual(authorized.custodyRoot, {
    absolutePath: alias,
    canonicalPath: await realpath(external),
  });

  const result = await createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  }).discoverClaudeCodeInstallations.execute({
    candidates: [authorized],
    observationEpoch: "epoch-external-target",
  });

  assert.equal(result.installations[0]?.status, "found_unverified");
  assert.deepEqual(result.diagnostics, []);
});

test("delegates macOS case and Unicode alias identity to the observer without rewriting display paths", async () => {
  const identities = new Map([
    ["case-upper", "same-file"],
    ["case-lower", "same-file"],
    ["unicode-composed", "same-file"],
    ["unicode-decomposed-other", "different-file"],
  ]);
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ authorizedFileIdentity }) {
        return { identity: identities.get(authorizedFileIdentity ?? "") ?? "unexpected", kind: "found" };
      },
    },
  });
  const candidates = [
    candidate("$HOME/bin/Claude", "explicit", { authorizedFileIdentity: "case-upper" }),
    candidate("$HOME/bin/claude", "path-entry", { authorizedFileIdentity: "case-lower" }),
    candidate("$HOME/bin/claud\u00e9", "path-entry", { authorizedFileIdentity: "unicode-composed" }),
    candidate("$HOME/bin/claude\u0301", "path-entry", {
      authorizedFileIdentity: "unicode-decomposed-other",
    }),
  ];

  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: candidates.toReversed(),
    observationEpoch: "epoch-macos-alias-semantics",
  });

  assert.deepEqual(
    result.installations.map(item => item.aliases.map(alias => alias.displayPath)),
    [
      ["$HOME/bin/Claude", "$HOME/bin/claude", "$HOME/bin/claud\u00e9"],
      ["$HOME/bin/claude\u0301"],
    ],
  );
});

test("reports required missing candidates and ignores optional missing candidates", async () => {
  const observer: ExecutableFileObserver = {
    async observe() {
      return { kind: "missing" };
    },
  };
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: observer,
  });
  const secretPath = "/secret/raw/claude";
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [
      candidate("required", "explicit", { absolutePath: secretPath }),
      candidate("optional", "path-entry", { absolutePath: secretPath }),
    ],
    observationEpoch: "epoch-missing",
  });

  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.code, "candidate_invalid");
  assert.match(result.diagnostics[0]?.candidateRef ?? "", /^claude-code-candidate:/u);
  assert.doesNotMatch(JSON.stringify(result), /secret\/raw/u);
});

test("classifies non-executable, hard-linked, FIFO, and replaced candidates", { timeout: 5_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-negatives-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const nonExecutable = join(root, "non-executable");
  const hardLinked = join(root, "hard-linked");
  const hardLinkAlias = join(root, "hard-linked-alias");
  const fifo = join(root, "fifo");
  const replaceable = join(root, "replaceable");
  await Promise.all([
    writeFile(nonExecutable, "synthetic"),
    writeFile(hardLinked, "synthetic"),
    writeFile(replaceable, "authorized"),
  ]);
  await Promise.all([chmod(hardLinked, 0o755), chmod(replaceable, 0o755)]);
  await link(hardLinked, hardLinkAlias);
  await execFile("/usr/bin/mkfifo", [fifo]);
  const candidates = await Promise.all([
    filesystemCandidate(root, nonExecutable, "non-executable", true),
    filesystemCandidate(root, hardLinked, "hard-linked", true),
    filesystemCandidate(root, fifo, "fifo", true),
    filesystemCandidate(root, replaceable, "replaceable", true),
  ]);
  await rm(replaceable);
  await writeFile(replaceable, "replacement");
  await chmod(replaceable, 0o755);

  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates,
    observationEpoch: "epoch-negatives",
  });

  assert.deepEqual(
    result.diagnostics.map(item => item.code),
    [
      "candidate_invalid",
      "candidate_unstable",
      "candidate_invalid",
      "candidate_unstable",
    ],
  );
  assert.deepEqual(result.installations, []);
});

test("rejects device and ancestor-retargeted candidates without opening them", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-special-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const trusted = join(root, "trusted");
  const retired = join(root, "retired");
  const broken = join(root, "broken");
  const executable = join(trusted, "bin", "claude");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "synthetic");
  await chmod(executable, 0o755);
  await symlink(join(root, "missing-target"), broken);
  const retargetedCandidate = await filesystemCandidate(
    trusted,
    executable,
    "$HOME/retargeted/claude",
    true,
  );
  await rename(trusted, retired);
  await symlink(retired, trusted);

  const observer = createNodeExecutableFileObserver();
  const [retargeted, device, brokenAlias] = await Promise.all([
    observer.observe({
      absolutePath: retargetedCandidate.absolutePath,
      authorizedFileIdentity: retargetedCandidate.authorizedFileIdentity,
      custodyBoundary: retargetedCandidate.custodyRoot,
      expectedCanonicalPath: retargetedCandidate.canonicalPath,
    }),
    observer.observe({
      absolutePath: "/dev/null",
      authorizedFileIdentity: "synthetic-device",
      custodyBoundary: {
        absolutePath: "/dev",
        canonicalPath: await realpath("/dev"),
      },
      expectedCanonicalPath: "/dev/null",
    }),
    observer.observe({
      absolutePath: broken,
      authorizedFileIdentity: undefined,
      custodyBoundary: {
        absolutePath: broken,
        canonicalPath: join(root, "missing-target"),
      },
      expectedCanonicalPath: join(root, "missing-target"),
    }),
  ]);

  assert.deepEqual(retargeted, { kind: "unstable" });
  assert.deepEqual(device, { kind: "invalid" });
  assert.deepEqual(brokenAlias, { kind: "missing" });
});

test("rejects a socket stat through the non-file alias gate", () => {
  const socketStat = {
    isFile: () => false,
    isSocket: () => true,
    isSymbolicLink: () => false,
  };

  assert.equal(socketStat.isSocket(), true);
  assert.equal(isSupportedExecutableAliasKind(socketStat), false);
});

test("checks owner, group, and other execute permission for the effective identity", () => {
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o100n), { gid: 3000, groups: [], uid: 1000 }),
    true,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o010n), { gid: 2000, groups: [], uid: 3000 }),
    true,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o010n), { gid: 3000, groups: [2000], uid: 3000 }),
    true,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o001n), { gid: 3000, groups: [], uid: 3000 }),
    true,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o010n), { gid: 3000, groups: [], uid: 1000 }),
    false,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o100n), { gid: 3000, groups: [], uid: 3000 }),
    false,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o001n), { gid: 2000, groups: [], uid: 3000 }),
    false,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o001n), { gid: 0, groups: [], uid: 0 }),
    true,
  );
  assert.equal(
    isExecutableByEffectiveIdentity(executableModeStats(0o000n), { gid: 0, groups: [], uid: 0 }),
    false,
  );
});

test("resolves the effective identity again for each executable observation", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-effective-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = join(root, "claude");
  await writeFile(executable, "synthetic");
  await chmod(executable, 0o500);
  const stats = await stat(executable, { bigint: true });
  const unrelatedUid = Number(stats.uid) === 1 ? 2 : 1;
  const unrelatedGid = Number(stats.gid) === 1 ? 2 : 1;
  const identities = [
    { gid: unrelatedGid, groups: [], uid: unrelatedUid },
    { gid: Number(stats.gid), groups: [], uid: Number(stats.uid) },
  ];
  let observation = 0;
  const observer = createNodeExecutableFileObserver({
    effectiveIdentitySupplier: () => identities[observation++],
  });
  const request = {
    absolutePath: executable,
    authorizedFileIdentity: await fileIdentity(executable),
    custodyBoundary: {
      absolutePath: executable,
      canonicalPath: await realpath(executable),
    },
    expectedCanonicalPath: await realpath(executable),
  };

  assert.deepEqual(await observer.observe(request), { kind: "invalid" });
  assert.equal((await observer.observe(request)).kind, "found");
  assert.equal(observation, 2);
});

test("reclassifies an executable after a supplied root privilege drop", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-privilege-drop-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const executable = join(root, "claude");
  await writeFile(executable, "synthetic");
  await chmod(executable, 0o500);
  const stats = await stat(executable, { bigint: true });
  const droppedUid = Number(stats.uid) === 1 ? 2 : 1;
  const droppedGid = Number(stats.gid) === 1 ? 2 : 1;
  const identities = [
    { gid: 0, groups: [], uid: 0 },
    { gid: droppedGid, groups: [], uid: droppedUid },
  ];
  let observation = 0;
  const observer = createNodeExecutableFileObserver({
    effectiveIdentitySupplier: () => identities[observation++],
  });
  const canonicalPath = await realpath(executable);
  const request = {
    absolutePath: executable,
    authorizedFileIdentity: await fileIdentity(executable),
    custodyBoundary: { absolutePath: executable, canonicalPath },
    expectedCanonicalPath: canonicalPath,
  };

  assert.equal((await observer.observe(request)).kind, "found");
  assert.deepEqual(await observer.observe(request), { kind: "invalid" });
  assert.equal(observation, 2);
});

test("never executes an executable candidate", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-passive-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const marker = join(root, "executed");
  const executable = join(root, "claude");
  await writeFile(executable, `#!/bin/sh\nprintf invoked > '${marker}'\n`);
  await chmod(executable, 0o755);
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: createNodeExecutableFileObserver(),
  });
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [
      await filesystemCandidate(root, executable, "$HOME/bin/claude", true),
    ],
    observationEpoch: "epoch-passive",
  });

  assert.equal(result.installations.length, 1);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const productionSource = await readFile(
    join(
      packageRoot,
      "src/features/runtime-installation-discovery/application/discover-claude-code-installations.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(
    productionSource,
    /child_process|\bfetch\b|node:(?:http|https|net|tls)|process\.(?:env|cwd)|\bauth(?:entication)?\b|installer|--version/u,
  );
});

test("maps denied, invalid, unreadable, and unstable observer outcomes", async () => {
  const outcomes = new Map([
    ["denied", { kind: "denied" } as const],
    ["invalid", { kind: "invalid" } as const],
    ["unreadable", { kind: "unreadable" } as const],
    ["unstable", { kind: "unstable" } as const],
  ]);
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ authorizedFileIdentity }) {
        return outcomes.get(authorizedFileIdentity ?? "") ?? { kind: "missing" };
      },
    },
  });
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: [...outcomes.keys()].map(value =>
      candidate(value, "explicit", { authorizedFileIdentity: value }),
    ),
    observationEpoch: "epoch-diagnostics",
  });

  assert.deepEqual(
    result.diagnostics.map(item => item.code),
    [
      "candidate_denied",
      "candidate_invalid",
      "candidate_unreadable",
      "candidate_unstable",
    ],
  );
});

test("propagates cancellation before and during candidate observation", async () => {
  const before = new AbortController();
  before.abort();
  const inertFeature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe() {
        return { identity: "unexpected", kind: "found" };
      },
    },
  });
  await assert.rejects(
    inertFeature.discoverClaudeCodeInstallations.execute(
      { candidates: [], observationEpoch: "epoch-before" },
      { signal: before.signal },
    ),
    { name: "AbortError" },
  );

  const during = new AbortController();
  const cancellingFeature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ signal }) {
        assert.equal(signal, during.signal);
        during.abort();
        return { identity: "not-returned", kind: "found" };
      },
    },
  });
  await assert.rejects(
    cancellingFeature.discoverClaudeCodeInstallations.execute(
      {
        candidates: [candidate("cancel", "explicit")],
        observationEpoch: "epoch-during",
      },
      { signal: during.signal },
    ),
    { name: "AbortError" },
  );
});

test("snapshots caller-owned candidates and returns detached deeply frozen output", async () => {
  let releaseObservation!: () => void;
  const observationMayFinish = new Promise<void>(resolve => {
    releaseObservation = resolve;
  });
  let observedRoot: { readonly absolutePath: string; readonly canonicalPath: string } | undefined;
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe({ authorizedFileIdentity, custodyBoundary }) {
        if (authorizedFileIdentity === "authorized-missing") {
          return { kind: "missing" };
        }
        observedRoot = custodyBoundary;
        await observationMayFinish;
        return { identity: "detached-file", kind: "found" };
      },
    },
  });
  const mutableCandidate = candidate("original", "explicit");
  const mutableCandidates = [
    mutableCandidate,
    candidate("missing", "explicit"),
  ];
  const pending = feature.discoverClaudeCodeInstallations.execute({
    candidates: mutableCandidates,
    observationEpoch: "epoch-detached",
  });

  mutableCandidate.displayPath = "mutated";
  mutableCandidate.source = "path-entry";
  mutableCandidate.custodyRoot.absolutePath = "/mutated";
  mutableCandidates.length = 0;
  releaseObservation();
  const result = await pending;

  assert.equal(observedRoot?.absolutePath, "/authorized");
  assert.deepEqual(result.installations[0]?.aliases, [
    { displayPath: "original", source: "explicit" },
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.diagnostics));
  assert.ok(Object.isFrozen(result.diagnostics[0]));
  assert.ok(Object.isFrozen(result.installations));
  assert.ok(Object.isFrozen(result.installations[0]));
  assert.ok(Object.isFrozen(result.installations[0]?.aliases));
  assert.ok(Object.isFrozen(result.installations[0]?.aliases[0]));
});

test("Claude production discovery graph has no process, network, ambient-state, or shell dependency", async () => {
  const sourceRoot = join(packageRoot, "src/features/runtime-installation-discovery");
  const productionSource = (
    await Promise.all(
      (await collectTypeScriptSources(sourceRoot)).map(path => readFile(path, "utf8")),
    )
  ).join("\n");

  assert.doesNotMatch(
    productionSource,
    /from\s+["']node:(?:child_process|cluster|dgram|dns|http|https|net|readline|repl|tls|worker_threads)["']|process\.(?:cwd|env)|\b(?:fetch|spawn|exec|execFile|fork)\s*\(|interactive[- ]?shell/iu,
  );
});

test("reports frozen candidate overflow without observing or truncating", async () => {
  let observed = false;
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe() {
        observed = true;
        return { identity: "unexpected", kind: "found" };
      },
    },
  });
  const result = await feature.discoverClaudeCodeInstallations.execute({
    candidates: Array.from({ length: 257 }, (_, index) =>
      candidate(`candidate-${index}`, "path-entry"),
    ),
    observationEpoch: "epoch-overflow",
  });

  assert.equal(observed, false);
  assert.deepEqual(result, {
    diagnostics: [
      {
        candidateRef: "claude-code-candidate-set:overflow",
        code: "candidate_invalid",
      },
    ],
    installations: [],
  });

  const explicitOverflow = await feature.discoverClaudeCodeInstallations.execute({
    candidates: Array.from({ length: 17 }, (_, index) =>
      candidate(`explicit-${index}`, "explicit"),
    ),
    observationEpoch: "epoch-explicit-overflow",
  });
  const pathOverflow = await feature.discoverClaudeCodeInstallations.execute({
    candidates: Array.from({ length: 65 }, (_, index) =>
      candidate(`path-${index}`, "path-entry"),
    ),
    observationEpoch: "epoch-path-overflow",
  });
  assert.equal(
    explicitOverflow.diagnostics[0]?.candidateRef,
    "claude-code-explicit-candidate-set:overflow",
  );
  assert.equal(
    pathOverflow.diagnostics[0]?.candidateRef,
    "claude-code-path-entry-candidate-set:overflow",
  );
});
