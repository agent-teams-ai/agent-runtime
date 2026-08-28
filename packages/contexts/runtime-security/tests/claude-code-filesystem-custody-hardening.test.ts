import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { openStablePath } from "@agent-teams/filesystem-custody";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "../dist/composition.js";

const execFile = promisify(execFileCallback);

const scope = (
  homeRoot: string,
  workspaceRoot: string,
  explicitExecutablePaths: readonly string[] = [],
) => ({
  candidatePaths: [
    ...explicitExecutablePaths.map(absolutePath => ({
      absolutePath,
      priorityRank: 1 as const,
      source: "explicit" as const,
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
  dialect: "claude-code-settings@2026-08-28" as const,
  homeRoot,
  observationEpoch: "claude-hardening-epoch",
  sourcePaths: [
    {
      absolutePath: join(homeRoot, ".claude", "settings.json"),
      kind: "user" as const,
    },
    {
      absolutePath: join(workspaceRoot, ".claude", "settings.json"),
      kind: "shared-project" as const,
    },
    {
      absolutePath: join(workspaceRoot, ".claude", "settings.local.json"),
      kind: "project-local" as const,
    },
  ],
  workspaceRoot,
  workspaceTrusted: true,
});

const assertDeepFrozen = (value: unknown): void => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {
    assertDeepFrozen(nested);
  }
};

const observingAuthorization = (calls: string[]) =>
  createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path) {
        calls.push(path);
        return { absolutePath: path, canonicalLocationPath: path, exists: false };
      },
    },
  }).authorizeClaudeCodeSetupInspection;

test("accepts only composition-bound portable sources and known locations", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const sourceScope = scope(home, workspace);
  sourceScope.sourcePaths[0]!.absolutePath = `${home}/caller-selected.json`;
  const sourceCalls: string[] = [];
  const sourceResult = await observingAuthorization(sourceCalls).execute(sourceScope);
  assert.equal(sourceResult.status, "authorized");
  if (sourceResult.status !== "authorized") {
    return;
  }
  assert.deepEqual(
    sourceResult.sources.map(source => [source.kind, source.access]),
    [
      ["user", "rejected"],
      ["shared-project", "rejected"],
      ["project-local", "rejected"],
    ],
  );
  assert.equal(sourceCalls.includes(`${home}/caller-selected.json`), false);
  assert.ok(sourceResult.diagnostics.some(item =>
    item.code === "source_epoch_stale" && item.safeRef === "scope"
  ));

  const knownScope = scope(home, workspace);
  const known = knownScope.candidatePaths.find(candidate =>
    candidate.source === "known-location" && candidate.priorityRank === 3
  );
  assert.ok(known);
  known.absolutePath = `${home}/caller-selected-claude`;
  const knownCalls: string[] = [];
  const knownResult = await observingAuthorization(knownCalls).execute(knownScope);
  assert.equal(knownResult.status, "authorized");
  if (knownResult.status !== "authorized") {
    return;
  }
  assert.equal(knownCalls.includes(`${home}/caller-selected-claude`), false);
  assert.ok(knownResult.diagnostics.some(item =>
    item.code === "candidate_invalid" && item.safeRef === "candidate-scope"
  ));
});

test("returns detached deeply frozen authorization data", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const candidate = `${home}/bin/claude`;
  const trustedScope = scope(home, workspace, [candidate]);
  const result = await observingAuthorization([]).execute(trustedScope);
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assertDeepFrozen(result);
  trustedScope.candidatePaths[0]!.absolutePath = "/attacker/replacement";
  assert.equal(result.executableCandidates[0]?.absolutePath, candidate);
  assert.throws(() => {
    const root = result.executableCandidates[0]!.custodyRoot as {
      absolutePath: string;
    };
    root.absolutePath = "/attacker/root";
  }, TypeError);
});

test("bounds metadata observations before invoking the filesystem adapter", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  const calls: string[] = [];
  const authorization = observingAuthorization(calls);
  const candidateResult = await authorization.execute(
    scope(
      home,
      workspace,
      Array.from(
        { length: 257 },
        (_, index) => `${home}/unobserved-candidate-${index}`,
      ),
    ),
  );
  assert.equal(candidateResult.status, "authorized");
  assert.equal(calls.some(path => path.includes("unobserved-candidate")), false);

  calls.length = 0;
  const sourceScope = scope(home, workspace);
  sourceScope.sourcePaths.push({
    absolutePath: `${home}/unobserved-source.json`,
    kind: "user",
  });
  const sourceResult = await authorization.execute(sourceScope);
  assert.equal(sourceResult.status, "authorized");
  assert.equal(calls.some(path => path.includes("unobserved-source")), false);
  assert.equal(calls.some(path => path.includes("/.claude/")), false);
});

test("propagates cancellation at every filesystem observation boundary", async () => {
  const home = "/synthetic/home";
  const workspace = "/synthetic/workspace";
  for (let abortAt = 1; abortAt <= 20; abortAt += 1) {
    const stage = new AbortController();
    let stageCalls = 0;
    const authorization = createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: {
        async canonicalize(path) {
          stageCalls += 1;
          if (stageCalls === abortAt) {
            stage.abort(new Error(`stage-${abortAt}-cancelled`));
          }
          return { absolutePath: path, canonicalLocationPath: path, exists: false };
        },
      },
    }).authorizeClaudeCodeSetupInspection;
    await assert.rejects(
      authorization.execute(scope(home, workspace), { signal: stage.signal }),
      new RegExp(`stage-${abortAt}-cancelled`, "u"),
    );
    assert.equal(stageCalls, abortAt);
  }
});

test("rejects an ancestor replacement between candidate custody checks", async t => {
  const root = await mkdtemp(join(tmpdir(), "ar-claude-ancestor-race-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const candidateParent = join(home, "bin");
  const displacedParent = join(home, "bin-before");
  const candidate = join(candidateParent, "claude");
  await Promise.all([mkdir(candidateParent, { recursive: true }), mkdir(workspace)]);
  await writeFile(candidate, "first");
  const canonicalizer = createNodePathCanonicalizer();
  let replaced = false;
  const result = await createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path, options) {
        const observation = await canonicalizer.canonicalize(path, options);
        if (
          path === candidate &&
          options?.custodyBoundary === undefined &&
          !replaced
        ) {
          replaced = true;
          await rename(candidateParent, displacedParent);
          await mkdir(candidateParent);
          await writeFile(candidate, "second");
        }
        return observation;
      },
    },
  }).authorizeClaudeCodeSetupInspection.execute(
    scope(home, workspace, [candidate]),
  );
  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") {
    return;
  }
  assert.equal(replaced, true);
  assert.equal(
    result.executableCandidates.some(item => item.source === "explicit"),
    false,
  );
  assert.ok(result.diagnostics.some(item =>
    item.code === "candidate_unstable" && item.safeRef === "explicit"
  ));
});

test(
  "never opens canonical targets outside an authorized root",
  { skip: process.platform === "win32", timeout: 5_000 },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-claude-preopen-containment-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([
      mkdir(home),
      mkdir(workspace),
      mkdir(outside),
    ]);
    const outsideFile = join(outside, "regular-file");
    const outsideFifo = join(outside, "fifo");
    await writeFile(outsideFile, "outside");
    await execFile("/usr/bin/mkfifo", [outsideFifo]);
    const targets = [outsideFile, "/dev/null", outsideFifo] as const;
    const aliases = await Promise.all(targets.map(async (target, index) => {
      const alias = join(home, `outside-alias-${index}`);
      await symlink(target, alias);
      return alias;
    }));
    const openedCanonicalPaths: string[] = [];
    const canonicalizer = createNodePathCanonicalizer({
      async openStablePath(absolutePath, canonicalPath, operation, options) {
        openedCanonicalPaths.push(canonicalPath);
        return openStablePath(absolutePath, canonicalPath, operation, options);
      },
    });

    const result = await createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: canonicalizer,
    }).authorizeClaudeCodeSetupInspection.execute(scope(home, workspace, aliases));

    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {
      return;
    }
    assert.equal(
      result.executableCandidates.some(item => item.source === "explicit"),
      false,
    );
    assert.ok(result.diagnostics.some(item =>
      item.code === "candidate_denied" && item.safeRef === "explicit"
    ));
    assert.equal(openedCanonicalPaths.includes(home), true);
    for (const target of targets) {
      assert.equal(openedCanonicalPaths.includes(target), false);
    }
  },
);

test(
  "refuses a device reached through an in-scope alias",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-claude-device-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const alias = join(home, "device");
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await symlink("/dev/null", alias);

    const result = await createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: createNodePathCanonicalizer(),
    }).authorizeClaudeCodeSetupInspection.execute(scope(home, workspace, [alias]));
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {
      return;
    }
    assert.equal(
      result.executableCandidates.some(item => item.source === "explicit"),
      false,
    );
    assert.ok(result.diagnostics.some(item =>
      item.code === "candidate_denied" && item.safeRef === "explicit"
    ));
  },
);

test(
  "refuses a Unix socket without blocking",
  { skip: process.platform === "win32" },
  async t => {
    const root = await mkdtemp(join(tmpdir(), "ar-claude-socket-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const socket = join(home, "socket");
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        t.skip("Unix socket creation is unavailable in this test sandbox");
        return;
      }
      throw error;
    }
    t.after(() => new Promise<void>(resolve => {
      server.close(() => resolve());
    }));

    const result = await createSetupInspectionAuthorizationFeature({
      pathCanonicalizer: createNodePathCanonicalizer(),
    }).authorizeClaudeCodeSetupInspection.execute(scope(home, workspace, [socket]));
    assert.equal(result.status, "authorized");
    if (result.status !== "authorized") {
      return;
    }
    assert.equal(
      result.executableCandidates.some(item => item.source === "explicit"),
      false,
    );
    assert.ok(result.diagnostics.some(item =>
      (item.code === "candidate_invalid" || item.code === "candidate_unreadable") &&
      (item.safeRef === "explicit" || item.safeRef === "$HOME/socket")
    ));
  },
);
