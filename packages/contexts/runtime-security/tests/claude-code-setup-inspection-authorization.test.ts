import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "../dist/composition.js";

const execFile = promisify(execFileCallback);

const scope = (
  homeRoot: string,
  workspaceRoot: string,
  overrides: Partial<{
    dialect: "claude-code-settings@2026-08-28";
    explicitExecutablePaths: readonly string[];
    observationEpoch: string;
    pathEntries: readonly string[];
    workspaceTrusted: boolean;
  }> = {},
) => {
  const values = {
    dialect: "claude-code-settings@2026-08-28" as const,
    explicitExecutablePaths: [],
    observationEpoch: "claude-epoch-1",
    pathEntries: [],
    workspaceTrusted: true,
    ...overrides,
  };
  return {
    candidatePaths: [
      ...values.explicitExecutablePaths.map(absolutePath => ({
        absolutePath,
        priorityRank: 1 as const,
        source: "explicit" as const,
      })),
      ...values.pathEntries.map(entry => ({
        absolutePath: join(entry, "claude"),
        priorityRank: 2 as const,
        source: "path-entry" as const,
      })),
      {
        absolutePath: join(homeRoot, ".local", "bin", "claude"),
        priorityRank: 3 as const,
        source: "known-location" as const,
      },
      {
        absolutePath: "/opt/homebrew/bin/claude",
        priorityRank: 4 as const,
        source: "known-location" as const,
      },
      {
        absolutePath: "/usr/local/bin/claude",
        priorityRank: 5 as const,
        source: "known-location" as const,
      },
    ],
    dialect: values.dialect,
    homeRoot,
    observationEpoch: values.observationEpoch,
    sourcePaths: [
      { absolutePath: join(homeRoot, ".claude", "settings.json"), kind: "user" as const },
      { absolutePath: join(workspaceRoot, ".claude", "settings.json"), kind: "shared-project" as const },
      { absolutePath: join(workspaceRoot, ".claude", "settings.local.json"), kind: "project-local" as const },
    ],
    workspaceRoot,
    workspaceTrusted: values.workspaceTrusted,
  };
};

test("rejects hardlinks, directories, and FIFOs", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-file-type-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const hardlinked = join(home, "hardlinked");
  const fifo = join(home, "fifo");
  const directory = join(home, "directory");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(directory, { recursive: true })]);
  await writeFile(hardlinked, "synthetic");
  await link(hardlinked, join(home, "peer"));
  await execFile("mkfifo", [fifo]);

  const result = await feature().authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      explicitExecutablePaths: [hardlinked, fifo, directory],
    }),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(
    result.executableCandidates.some(candidate => candidate.source === "explicit"),
    false,
  );
  assert.equal(
    result.diagnostics.filter(item =>
      (item.code === "candidate_invalid" || item.code === "candidate_unreadable") &&
      (item.safeRef === "explicit" || item.safeRef?.startsWith("$HOME/") === true)
    ).length,
    3,
  );
});

test("rejects a Unix socket observation without opening it", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const socket = `${home}/socket`;
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: path === socket,
          ...(path === socket
            ? { fileIdentity: "socket", isFile: false, linkCount: 1 }
            : {}),
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, { explicitExecutablePaths: [socket] }),
  );

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(
    result.executableCandidates.some(candidate => candidate.source === "explicit"),
    false,
  );
  assert.ok(result.diagnostics.some(item =>
    item.code === "candidate_invalid" && item.safeRef === "$HOME/socket"
  ));
});

test("rejects non-regular portable sources", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-source-type-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(join(home, ".claude", "settings.json"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
  ]);
  const shared = join(workspace, ".claude", "settings.json");
  await writeFile(shared, "{}");
  await link(shared, join(workspace, ".claude", "shared-peer"));

  const result = await feature().authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.deepEqual(result.sources.map(source => [source.kind, source.access]), [
    ["user", "stale"],
    ["shared-project", "stale"],
    ["project-local", "authorized"],
  ]);
  assert.deepEqual(
    result.diagnostics.filter(item => item.code === "source_epoch_stale"),
    [
      { code: "source_epoch_stale", safeRef: "shared-project" },
      { code: "source_epoch_stale", safeRef: "user" },
    ],
  );
});

const feature = () => createSetupInspectionAuthorizationFeature({
  pathCanonicalizer: createNodePathCanonicalizer(),
});

test("authorizes the three planned fixed sources and preserves provider candidate priority", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-map-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const explicitBin = join(home, "explicit", "claude");
  const pathBin = join(workspace, "bin", "claude");
  const knownHome = join(home, ".local", "bin", "claude");
  await Promise.all([
    mkdir(join(home, ".claude"), { recursive: true }),
    mkdir(join(workspace, ".claude"), { recursive: true }),
    mkdir(join(home, "explicit"), { recursive: true }),
    mkdir(join(workspace, "bin"), { recursive: true }),
    mkdir(join(home, ".local", "bin"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(home, ".claude", "settings.json"), "{}"),
    writeFile(join(workspace, ".claude", "settings.json"), "{}"),
    writeFile(join(workspace, ".claude", "settings.local.json"), "{}"),
    writeFile(explicitBin, "synthetic"),
    writeFile(pathBin, "synthetic"),
    writeFile(knownHome, "synthetic"),
  ]);

  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false,
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      explicitExecutablePaths: [explicitBin],
      pathEntries: [join(workspace, "bin")],
    }),
  );

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.deepEqual(result.sources.map(source => source.kind), [
    "user",
    "shared-project",
    "project-local",
  ]);
  assert.deepEqual(
    result.sources.map(source => source.displayPath),
    [
      "$HOME/.claude/settings.json",
      "$WORKSPACE/.claude/settings.json",
      "$WORKSPACE/.claude/settings.local.json",
    ],
  );
  assert.deepEqual(
    result.executableCandidates.map(candidate => candidate.priorityRank),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    result.executableCandidates.slice(-2).map(candidate => candidate.displayPath),
    ["$HOMEBREW/bin/claude", "$LOCAL/bin/claude"],
  );
  assert.equal(
    new Set(result.executableCandidates.map(candidate => candidate.candidateIdentity)).size,
    result.executableCandidates.length,
  );
});

test("does not let caller ordering establish product precedence", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-priority-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const a = join(home, "a");
  const z = join(home, "z");
  await Promise.all([writeFile(a, "a"), writeFile(z, "z")]);
  const authorize = (paths: readonly string[]) =>
    feature().authorizeClaudeCodeSetupInspection.execute(
      scope(home, workspace, { explicitExecutablePaths: paths }),
    );

  const [first, second] = await Promise.all([
    authorize([z, a]),
    authorize([a, z]),
  ]);
  assert.deepEqual(first, second);
});

test("snapshots trusted roots and candidate inputs before asynchronous work", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const explicit = `${home}/claude`;
  const mutableScope = scope(home, workspace, {
    explicitExecutablePaths: [explicit],
  });
  const calls: string[] = [];
  let mutated = false;
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        calls.push(path);
        if (!mutated) {
          mutated = true;
          mutableScope.homeRoot = "/attacker/home";
          mutableScope.workspaceRoot = "/attacker/workspace";
          mutableScope.candidatePaths = [{
            absolutePath: "/attacker/claude",
            priorityRank: 1,
            source: "explicit",
          }];
          mutableScope.sourcePaths = [{
            absolutePath: "/attacker/settings.json",
            kind: "user",
          }];
        }
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false,
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(mutableScope);

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(calls.some(path => path.startsWith("/attacker/")), false);
  assert.ok(result.executableCandidates.some(candidate =>
    candidate.absolutePath === explicit && candidate.priorityRank === 1
  ));
});

test("rejects untrusted workspace sources without observing their paths", async () => {
  const calls: string[] = [];
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        calls.push(path);
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false,
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, { workspaceTrusted: false }),
  );

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.deepEqual(result.sources.map(source => [source.kind, source.access]), [
    ["user", "authorized"],
    ["shared-project", "untrusted"],
    ["project-local", "untrusted"],
  ]);
  assert.equal(
    calls.some(path => path.startsWith(`${workspace}/.claude/`)),
    false,
  );
  assert.deepEqual(
    result.diagnostics.filter(item => item.code === "source_untrusted"),
    [
      { code: "source_untrusted", safeRef: "project-local" },
      { code: "source_untrusted", safeRef: "shared-project" },
    ],
  );
});

test("rejects relative, outside, sibling-prefix, and symlink escape candidates", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-scope-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const sibling = join(root, "home-twin");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(home),
    mkdir(workspace),
    mkdir(sibling),
    mkdir(outside),
  ]);
  const outsideTarget = join(outside, "claude");
  const escapedAlias = join(home, "escaped");
  await writeFile(outsideTarget, "synthetic");
  await writeFile(join(sibling, "claude"), "synthetic");
  await symlink(outsideTarget, escapedAlias);

  const result = await feature().authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      explicitExecutablePaths: [
        "relative",
        join(root, "outside", "claude"),
        join(sibling, "claude"),
        escapedAlias,
      ],
    }),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(
    result.executableCandidates.some(candidate => candidate.source === "explicit"),
    false,
  );
  assert.deepEqual(
    result.diagnostics.filter(item => item.safeRef === "explicit" || item.safeRef === "explicit-path")
      .map(item => item.code)
      .toSorted(),
    ["candidate_denied", "candidate_denied", "candidate_denied", "candidate_invalid"],
  );
});

test("detects candidate and source identity changes on repeat checks", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const candidate = `${home}/bin/claude`;
  const userSource = `${home}/.claude/settings.json`;
  let candidateChecks = 0;
  let sourceChecks = 0;
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        if (path === candidate) {
          candidateChecks += 1;
          return {
            absolutePath: path,
            canonicalLocationPath: path,
            exists: true,
            fileIdentity: candidateChecks === 1 ? "candidate-a" : "candidate-b",
            isFile: true,
            linkCount: 1,
          };
        }
        if (path === userSource) {
          sourceChecks += 1;
          return {
            absolutePath: path,
            canonicalLocationPath: path,
            exists: true,
            fileIdentity: sourceChecks === 1 ? "source-a" : "source-b",
            isFile: true,
            linkCount: 1,
          };
        }
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false,
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, { explicitExecutablePaths: [candidate] }),
  );

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(candidateChecks, 2);
  assert.equal(sourceChecks, 2);
  assert.equal(
    result.executableCandidates.some(item => item.source === "explicit"),
    false,
  );
  assert.equal(
    result.sources.find(source => source.kind === "user")?.access,
    "stale",
  );
  assert.ok(result.diagnostics.some(item => item.code === "candidate_unstable"));
  assert.ok(result.diagnostics.some(item =>
    item.code === "source_epoch_stale" && item.safeRef === "user"
  ));
});

test("rejects an executable alias retargeted between authorization checks", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const alias = `${home}/bin/claude`;
  let checks = 0;
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        if (path === alias) {
          checks += 1;
          return {
            absolutePath: `${home}/targets/${checks === 1 ? "a" : "b"}`,
            canonicalLocationPath: alias,
            exists: true,
            fileIdentity: checks === 1 ? "alias-a" : "alias-b",
            isFile: true,
            linkCount: 1,
          };
        }
        return {
          absolutePath: path,
          canonicalLocationPath: path,
          exists: false,
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, { explicitExecutablePaths: [alias] }),
  );

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(checks, 2);
  assert.equal(
    result.executableCandidates.some(candidate => candidate.source === "explicit"),
    false,
  );
  assert.ok(result.diagnostics.some(item =>
    item.code === "candidate_unstable" && item.safeRef === "explicit"
  ));
});

test("fails closed for duplicate roots and duplicate canonical sources", async () => {
  const duplicateRoots = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        return { absolutePath: path, canonicalLocationPath: path, exists: false };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope("/synthetic/same", "/synthetic/same"),
  );
  assert.deepEqual(duplicateRoots, {
    diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
    status: "denied",
  });

  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const shared = `${workspace}/.claude/settings.json`;
  const local = `${workspace}/.claude/settings.local.json`;
  const duplicateSources = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        const canonical = path === local ? shared : path;
        return {
          absolutePath: canonical,
          canonicalLocationPath: canonical,
          exists: path === shared || path === local,
          ...(path === shared || path === local
            ? { fileIdentity: "same", isFile: true, linkCount: 1 }
            : {}),
        };
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(scope(home, workspace));
  assert.equal(duplicateSources.status, "authorized");
  if (duplicateSources.status !== "authorized") {return;}
  assert.deepEqual(
    duplicateSources.sources.map(source => [source.kind, source.access]),
    [
      ["user", "authorized"],
      ["shared-project", "rejected"],
      ["project-local", "rejected"],
    ],
  );
  assert.ok(duplicateSources.diagnostics.some(item =>
    item.code === "source_epoch_stale" && item.safeRef === "duplicate-source"
  ));
});

test("enforces candidate and path budgets with redacted diagnostics", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const sensitivePaths = [
    `/outside/${"secret-sentinel\n".repeat(2)}`,
    "/outside/route-bedrock-project-123",
    "/outside/credential-anthropic-api-key",
    "/outside/managed-policy-value",
  ];
  const canonicalizer = {
    async canonicalize(path: string) {
      return { absolutePath: path, canonicalLocationPath: path, exists: false };
    },
  };
  const overBudget = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: canonicalizer,
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      explicitExecutablePaths: Array.from({ length: 17 }, (_, index) =>
        `${home}/candidate-${index}`
      ),
    }),
  );
  assert.equal(overBudget.status, "authorized");
  if (overBudget.status !== "authorized") {return;}
  assert.ok(overBudget.diagnostics.some(item =>
    item.code === "candidate_invalid" && item.safeRef === "candidate-budget"
  ));

  const pathEntryBudget = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: canonicalizer,
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      pathEntries: Array.from({ length: 65 }, (_, index) =>
        `${home}/bin-${index}`
      ),
    }),
  );
  assert.equal(pathEntryBudget.status, "authorized");
  if (pathEntryBudget.status !== "authorized") {return;}
  assert.ok(pathEntryBudget.diagnostics.some(item =>
    item.code === "candidate_invalid" && item.safeRef === "candidate-budget"
  ));

  const oversizedRoot = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: canonicalizer,
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(`/${"h".repeat(16_384)}`, workspace),
  );
  assert.deepEqual(oversizedRoot, {
    diagnostics: [{ code: "source_epoch_stale", safeRef: "scope" }],
    status: "denied",
  });

  const derivedPathBudget = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: canonicalizer,
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(`/${"h".repeat(16_383)}`, workspace),
  );
  assert.equal(derivedPathBudget.status, "authorized");
  if (derivedPathBudget.status !== "authorized") {return;}
  assert.equal(
    derivedPathBudget.sources.find(source => source.kind === "user")?.access,
    "rejected",
  );
  assert.ok(derivedPathBudget.diagnostics.some(item =>
    item.code === "source_epoch_stale" && item.safeRef === "scope"
  ));

  const redacted = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: canonicalizer,
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, {
      explicitExecutablePaths: [...sensitivePaths, `/${"x".repeat(16_384)}`],
    }),
  );
  assert.equal(redacted.status, "authorized");
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes("secret-sentinel"), false);
  assert.equal(serialized.includes("bedrock-project-123"), false);
  assert.equal(serialized.includes("anthropic-api-key"), false);
  assert.equal(serialized.includes("managed-policy-value"), false);
  assert.equal(serialized.includes("/outside"), false);
  assert.equal(serialized.includes("\n"), false);
});

test("propagates cancellation before work and after awaited boundaries", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const preCancelled = new AbortController();
  preCancelled.abort(new Error("pre-cancelled"));
  let calls = 0;
  const authorization = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        calls += 1;
        return { absolutePath: path, canonicalLocationPath: path, exists: false };
      },
    },
  }).authorizeClaudeCodeSetupInspection;
  await assert.rejects(
    authorization.execute(scope(home, workspace), { signal: preCancelled.signal }),
    /pre-cancelled/u,
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  const boundaryAuthorization = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        during.abort(new Error("boundary-cancelled"));
        return { absolutePath: path, canonicalLocationPath: path, exists: false };
      },
    },
  }).authorizeClaudeCodeSetupInspection;
  await assert.rejects(
    boundaryAuthorization.execute(scope(home, workspace), { signal: during.signal }),
    /boundary-cancelled/u,
  );

});

test("rejects an ancestor symlink escape for a fixed source", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-ancestor-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(outside)]);
  await writeFile(join(outside, "settings.json"), "{}");
  await symlink(outside, join(home, ".claude"));

  const result = await feature().authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {return;}
  assert.equal(
    result.sources.find(source => source.kind === "user")?.access,
    "stale",
  );
  assert.ok(result.diagnostics.some(item =>
    item.code === "source_epoch_stale" && item.safeRef === "user"
  ));
});
