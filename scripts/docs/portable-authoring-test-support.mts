import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as docsQualification from "@agent-teams/docs-protocol/qualification";
import { currentPortableRunId, portableScenarioIds, scopeSchema } from "./portable-authoring-policy.mts";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const protocolManifest = fileURLToPath(import.meta.resolve("@agent-teams/docs-protocol/package.json"));
const foundationManifest = fileURLToPath(import.meta.resolve("@agent-teams/engineering-foundation/package.json"));
const protocolCli = join(dirname(protocolManifest), "dist/cli.js");
const protocolProfile = "architecture/foundation/docs-protocol.yaml";
const envelopeSchema = z.object({ outcome: z.string(), diagnostics: z.array(z.object({ ruleId: z.string() })), result: z.unknown() });
const previewSchema = z.object({ documentPath: z.string(), planDigest: z.string(), reachability: z.unknown(),
  compiled: z.object({ frontmatter: z.string(), metadata: z.object({ owner: z.string(), id: z.string() }), document: z.object({ content: z.string() }) }) });
const scenarioSchema = z.object({ schemaVersion: z.literal(2), scenarios: z.array(z.object({
  id: z.enum(portableScenarioIds), type: z.enum(["index", "architecture", "adr", "evidence", "qualification-plan"]),
  intent: z.object({ id: z.string(), title: z.string(), owner: z.string(), summary: z.string(), slug: z.string().optional(), related: z.array(z.string()).optional() }),
  expected: z.object({ documentPath: z.string(), metadataStorage: z.literal("frontmatter"), reachability: z.unknown() })
})) });

async function copyFile(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function addRequiredAnchorFixtures(root: string) {
  await copyFile(join(repositoryRoot, "architecture/feature-module-standard/candidate-profile.json"), join(root, "architecture/feature-module-standard/candidate-profile.json"));
  await copyFile(join(repositoryRoot, "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json"), join(root, "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json"));
  await copyFile(join(repositoryRoot, "packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs"), join(root, "packages/contexts/agent-execution/tests/live/claude-contained-turn-live-canary.mjs"));
  await copyFile(join(repositoryRoot, "scripts/architecture/check-feature-modules.mjs"), join(root, "scripts/architecture/check-feature-modules.mjs"));
  await copyFile(
    join(repositoryRoot, "architecture/decisions/accepted-decisions.json"),
    join(root, "architecture/decisions/accepted-decisions.json")
  );
  for (const path of [
    "architecture/consumer-module-standard/contained-turn-profile.json",
    "architecture/feature-module-standard/candidate-profile.json",
    "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/contained-turn-v1-contract.json",
    "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/README.md",
    "experiments/rust-system-boundaries/README.md",
    "experiments/sandbox-backend-hosting/README.md",
    "packages/apps/embedded-runtime/src/index.ts",
    "packages/apps/embedded-runtime/src/features/ordinary-session-runtime/README.md",
    "packages/contexts/runtime-configuration/src/features/claude-code-configuration-inspection/README.md",
    "packages/contexts/runtime-configuration/src/features/codex-configuration-inspection/README.md",
    "packages/contexts/runtime-security/src/features/contained-turn-dispatch-authority/README.md",
    "packages/contexts/runtime-security/src/features/contained-turn-egress/README.md",
    "packages/contexts/runtime-security/src/features/provider-process-egress-authorization/README.md",
    "packages/contexts/runtime-security/src/features/setup-source-inspection-authorization/README.md",
    "packages/platform/filesystem-custody/src/features/stable-filesystem-custody/README.md",
    "scripts/architecture/check-consumer-module-standard.mjs",
    "scripts/architecture/feature-module-edges.mjs",
    "scripts/architecture/feature-module-profile.mjs"
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "Disposable code-anchor fixture.\n", "utf8");
  }
}

async function attachPublishedTooling(root: string) {
  const [manifestSource, protocolSource, foundationSource] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(protocolManifest, "utf8"),
    readFile(foundationManifest, "utf8")
  ]);
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(manifestSource));
  const protocol = z.object({ version: z.string() }).parse(JSON.parse(protocolSource));
  const foundation = z.object({ version: z.string() }).parse(JSON.parse(foundationSource));
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    ...manifest,
    devDependencies: {
      "@agent-teams/docs-protocol": protocol.version,
      "@agent-teams/engineering-foundation": foundation.version
    }
  }, null, 2)}\n`, "utf8");

  const scope = join(root, "node_modules", "@agent-teams");
  await mkdir(scope, { recursive: true });
  const kind = process.platform === "win32" ? "junction" : "dir";
  await Promise.all([
    symlink(dirname(protocolManifest), join(scope, "docs-protocol"), kind),
    symlink(dirname(foundationManifest), join(scope, "engineering-foundation"), kind)
  ]);
}

export async function disposableRepository(run: (root: string) => Promise<void>, { attachTooling = false } = {}) {
  // macOS temp roots can traverse /var; qualification requires direct physical paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), "atd-r-")));
  try {
    await cp(join(repositoryRoot, "docs"), join(root, "docs"), { recursive: true });
    await mkdir(join(root, "architecture", "foundation"), { recursive: true });
    await cp(
      join(repositoryRoot, "architecture", "foundation", "document-authoring.yaml"),
      join(root, "architecture", "foundation", "document-authoring.yaml")
    );
    await cp(
      join(repositoryRoot, "architecture", "foundation", "docs-protocol.yaml"),
      join(root, "architecture", "foundation", "docs-protocol.yaml")
    );
    await mkdir(join(root, ".agents", "skills", "docs-authoring"), { recursive: true });
    await cp(
      join(repositoryRoot, ".agents", "skills", "docs-authoring", "SKILL.md"),
      join(root, ".agents", "skills", "docs-authoring", "SKILL.md")
    );
    await cp(join(repositoryRoot, "AGENTS.md"), join(root, "AGENTS.md"));
    await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
    await addRequiredAnchorFixtures(root);
    if (attachTooling) {
      await attachPublishedTooling(root);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function docs(root: string, command: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      protocolCli,
      command,
      "--consumer",
      root,
      "--profile",
      protocolProfile,
      "--json",
      ...args
    ],
    { encoding: "utf8", cwd: root, env: process.env }
  );
  let envelope;
  try {
    envelope = envelopeSchema.parse(JSON.parse(result.stdout));
  } catch {
    assert.fail(`Docs Protocol did not return JSON. stderr: ${result.stderr}`);
  }
  return { envelope, status: result.status, stderr: result.stderr };
}

// Runtime owns these fixed intents and assertions; installed Docs Protocol owns qualification.
export async function assertQualificationAllocationDisposed(innerRoot: string) {
  await assert.rejects(lstat(dirname(innerRoot)), { code: "ENOENT" },
    "installed SDK allocation must be fully disposed before consumer cleanup");
}
export async function runPortableAuthoringScenario(id: typeof portableScenarioIds[number]) {
  const runId = currentPortableRunId(), entryFile = realpathSync(z.string().parse(process.argv[1]));
  const contract = scenarioSchema.parse(JSON.parse(await readFile(join(repositoryRoot,
    "architecture/foundation/docs-protocol-qualification.json"), "utf8")));
  assert.deepEqual(contract.scenarios.map(entry => entry.id), [...portableScenarioIds]);
  const scenario = contract.scenarios.find(entry => entry.id === id);
  assert.ok(scenario, `missing scenario ${id}`);
  const scope = await realpath(await mkdtemp(join(tmpdir(), "dq-")));
  const start = Date.now(), previousCwd = process.cwd();
  const keys = ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "npm_config_cache", "PNPM_HOME"] as const;
  const previous = keys.map(key => process.env[key]);
  const home = join(scope, "h"), cache = join(scope, "c"), temp = join(scope, "t");
  let outer = "", innerRoot = "";
  try {
    await Promise.all([home, cache, temp].map(path => mkdir(path)));
    for (const key of keys) {process.env[key] = key === "HOME" || key === "USERPROFILE" ? home
      : ["TMPDIR", "TMP", "TEMP"].includes(key) ? temp : cache;}
    await disposableRepository(async root => {
      outer = root;
      process.chdir(root);
      const { related, slug, ...intent } = scenario.intent;
      const args = ["--type", scenario.type, "--id", intent.id, "--title", intent.title,
        "--owner", intent.owner, "--summary", intent.summary,
        ...(slug === undefined ? [] : ["--slug", slug]),
        ...(related ?? []).flatMap(relatedId => ["--related", relatedId])];
      const beforePreview = await docsQualification.fileSnapshot(root);
      const preview = docs(root, "new", ...args, "--dry-run");
      const planned = previewSchema.parse(preview.envelope.result);
      assert.equal(preview.status, 0, JSON.stringify(preview.envelope));
      assert.equal(planned.documentPath, scenario.expected.documentPath);
      assert.equal(scenario.expected.metadataStorage, "frontmatter");
      assert.ok(planned.compiled.frontmatter.length > 0);
      assert.equal(planned.compiled.metadata.owner, intent.owner);
      assert.equal(planned.compiled.metadata.id, intent.id);
      assert.deepEqual(planned.reachability, scenario.expected.reachability);
      const stale = docs(root, "new", ...args, "--apply", "--expect", `sha256:${"0".repeat(64)}`);
      assert.notEqual(stale.status, 0);
      assert.ok(stale.envelope.diagnostics.some(({ ruleId }) => ruleId === "docs.new.plan-digest-stale"), JSON.stringify(stale.envelope));
      await assert.rejects(readFile(join(root, scenario.expected.documentPath)), { code: "ENOENT" });
      assert.deepEqual(await docsQualification.fileSnapshot(root), beforePreview);
      const innerRoots = new Set<string>();
      let observationError: unknown;
      // Observe allocation once. Repeated synchronous polling can delay the owned
      // crash child's durable-journal handshake under a constrained filesystem.
      const watchers: FSWatcher[] = [];
      const allocations = new Set<string>();
      const observer = watch(process.env.TMPDIR!, (_event, name) => {
        if (name === null || !name.startsWith("atd-q-") || allocations.has(name)) { return; }
        allocations.add(name);
        const allocation = join(process.env.TMPDIR!, name);
        const inner = join(allocation, "consumer");
        try {
          let consumerWatcher: FSWatcher;
          const observe = () => {
            try {
              assert.ok(lstatSync(inner).isDirectory());
              assert.equal(realpathSync(inner), inner);
              innerRoots.add(inner);
              consumerWatcher.close();
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { observationError = error; }
            }
          };
          consumerWatcher = watch(allocation, observe);
          watchers.push(consumerWatcher);
          observe();
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) { observationError = error; }
        }
      });
      let receipt: docsQualification.DocsProtocolQualificationReceipt;
      try { receipt = await docsQualification.runDocsProtocolQualification({
        fixtureRoot: root,
        profilePath: protocolProfile,
        scenario: {
          find: { query: { id: "ADR-0001" }, expectedIds: ["ADR-0001"] },
          newDocument: { intent: { type: scenario.type, ...intent, ...(slug === undefined ? {} : { slug }) },
            ...(related === undefined ? {} : { related }) }
        }
      });
      } finally { observer.close(); for (const watcher of watchers) { watcher.close(); } }
      assert.equal(observationError, undefined);
      assert.equal(innerRoots.size, 1, "one physical installed inner qualification consumer");
      innerRoot = [...innerRoots][0]!;
      await assertQualificationAllocationDisposed(innerRoot);
      assert.equal(receipt.projectId, "agent-runtime");
      assert.equal(receipt.appliedDocumentPath, scenario.expected.documentPath);
      assert.deepEqual(receipt.checks, ["info", "find", "preview", "crash", "doctor", "recover", "receipt", "parent", "apply", "index", "check", "source-unchanged"]);
      const applied = docs(root, "new", ...args, "--apply", "--expect", planned.planDigest);
      assert.equal(applied.status, 0, JSON.stringify(applied.envelope));
      assert.equal(await readFile(join(root, scenario.expected.documentPath), "utf8"),
        planned.compiled.document.content);
      await docsQualification.applyReachability(root, scenario.expected.reachability);
      const context = docs(root, "context", "--id", intent.id);
      assert.equal(context.status, 0, JSON.stringify(context.envelope));
      const check = docs(root, "check");
      assert.equal(check.status, 0, JSON.stringify(check.envelope));
    }, { attachTooling: true });
  } finally {
    process.chdir(previousCwd);
    keys.forEach((key, index) => { const value = previous[index]; if (value === undefined) {delete process.env[key];} else {process.env[key] = value;} });
    await rm(scope, { recursive: true, force: true });
  }
  await assert.rejects(realpath(scope), { code: "ENOENT" });
  console.log("DOCS_SCOPE " + JSON.stringify(scopeSchema.parse({ id, runId, entryFile, pid: process.pid, start, end: Date.now(), scope,
    outer, inner: innerRoot, cwd: outer, home, cache, temp, cleaned: true })));
}
