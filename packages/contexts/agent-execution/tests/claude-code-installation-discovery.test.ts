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
import { isSupportedExecutableAliasKind } from "../dist/features/runtime-installation-discovery/adapters/outbound/node-executable-file-observer.js";

const execFile = promisify(execFileCallback);
const packageRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

const fileIdentity = async (path: string): Promise<string> => {
  const observation = await stat(path, { bigint: true });
  return `${observation.dev}:${observation.ino}:${observation.ctimeNs}:${observation.size}`;
};

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
  canonicalPath: `/canonical/${displayPath}`,
  custodyRoot: {
    absolutePath: "/authorized",
    canonicalPath: "/canonical",
  },
  displayPath,
  required: source === "explicit",
  source,
  ...overrides,
});

const filesystemCandidate = async (
  root: string,
  absolutePath: string,
  displayPath: string,
  required: boolean,
  source: "explicit" | "known-location" | "path-entry" = "explicit",
) => ({
  absolutePath,
  authorizedFileIdentity: await fileIdentity(absolutePath),
  canonicalPath: await realpath(absolutePath),
  custodyRoot: {
    absolutePath: root,
    canonicalPath: await realpath(root),
  },
  displayPath,
  required,
  source,
});

test("orders explicit, PATH, and frozen known-location aliases deterministically", async () => {
  const identities = new Map([
    ["explicit-b", "shared"],
    ["path-b", "shared"],
    ["$HOME/.local/bin/claude", "shared"],
    ["/opt/homebrew/bin/claude", "shared"],
    ["/usr/local/bin/claude", "shared"],
    ["explicit-a", "first"],
  ]);
  const observer: ExecutableFileObserver = {
    async observe(_absolutePath, _canonicalPath, authorizedFileIdentity) {
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
    candidate("/usr/local/bin/claude", "known-location"),
    candidate("path-b", "path-entry"),
    candidate("explicit-b", "explicit"),
    candidate("/opt/homebrew/bin/claude", "known-location"),
    candidate("explicit-a", "explicit"),
    candidate("$HOME/.local/bin/claude", "known-location"),
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
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
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

test("delegates macOS case and Unicode alias identity to the observer without rewriting display paths", async () => {
  const identities = new Map([
    ["case-upper", "same-file"],
    ["case-lower", "same-file"],
    ["unicode-composed", "same-file"],
    ["unicode-decomposed-other", "different-file"],
  ]);
  const feature = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(_absolutePath, _canonicalPath, identity) {
        return { identity: identities.get(identity ?? "") ?? "unexpected", kind: "found" };
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
  const executable = join(trusted, "bin", "claude");
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, "synthetic");
  await chmod(executable, 0o755);
  const retargetedCandidate = await filesystemCandidate(
    trusted,
    executable,
    "$HOME/retargeted/claude",
    true,
  );
  await rename(trusted, retired);
  await symlink(retired, trusted);

  const observer = createNodeExecutableFileObserver();
  const [retargeted, device] = await Promise.all([
    observer.observe(
      retargetedCandidate.absolutePath,
      retargetedCandidate.canonicalPath,
      retargetedCandidate.authorizedFileIdentity,
      retargetedCandidate.custodyRoot,
    ),
    observer.observe("/dev/null", "/dev/null", "synthetic-device", {
      absolutePath: "/dev",
      canonicalPath: await realpath("/dev"),
    }),
  ]);

  assert.deepEqual(retargeted, { kind: "unstable" });
  assert.deepEqual(device, { kind: "invalid" });
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
      async observe(_absolutePath, _canonicalPath, identity) {
        return outcomes.get(identity ?? "") ?? { kind: "missing" };
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
      async observe(_absolutePath, _canonicalPath, _identity, _root, options) {
        assert.equal(options?.signal, during.signal);
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
      async observe(_absolutePath, _canonicalPath, identity, custodyRoot) {
        if (identity === "authorized-missing") {
          return { kind: "missing" };
        }
        observedRoot = custodyRoot;
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
