import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runDocsProtocolQualification } from "@agent-teams/docs-protocol/qualification";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const protocolManifest = fileURLToPath(
  import.meta.resolve("@agent-teams/docs-protocol/package.json")
);
const foundationManifest = fileURLToPath(
  import.meta.resolve("@agent-teams/engineering-foundation/package.json")
);
const protocolCli = join(dirname(protocolManifest), "dist/cli.js");
const protocolProfile = "architecture/foundation/docs-protocol.yaml";

test("qualification manifest binds the exact protocol gate and registry packages", async () => {
  const [qualification, manifest] = await Promise.all([
    readFile(join(repositoryRoot, "architecture/foundation/docs-protocol-qualification.json"), "utf8").then(JSON.parse),
    readFile(join(repositoryRoot, "package.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(qualification.gateCommand, "pnpm docs:protocol:check");
  assert.deepEqual(qualification.packages, {
    "@agent-teams/docs-protocol": manifest.devDependencies["@agent-teams/docs-protocol"],
    "@agent-teams/engineering-foundation": manifest.devDependencies["@agent-teams/engineering-foundation"],
  });
  assert.deepEqual(qualification.qualificationTests, [
    "scripts/docs/docs-protocol-adoption.test.mjs",
    "scripts/docs/verify-frozen-document-bytes.test.mjs"
  ]);
});

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function addRequiredAnchorFixtures(root) {
  await copyFile(
    join(repositoryRoot, "architecture/decisions/accepted-decisions.json"),
    join(root, "architecture/decisions/accepted-decisions.json")
  );
  for (const path of [
    "experiments/runtime-profile-behavior/spec/runtime-operation-oracle/README.md",
    "experiments/rust-system-boundaries/README.md",
    "experiments/sandbox-backend-hosting/README.md",
    "packages/apps/embedded-runtime/src/index.ts"
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "Disposable code-anchor fixture.\n", "utf8");
  }
}

async function attachPublishedTooling(root) {
  const [manifestSource, protocolSource, foundationSource] = await Promise.all([
    readFile(join(root, "package.json"), "utf8"),
    readFile(protocolManifest, "utf8"),
    readFile(foundationManifest, "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const protocol = JSON.parse(protocolSource);
  const foundation = JSON.parse(foundationSource);
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

async function disposableRepository(run, { attachTooling = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atd-r-"));
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

function docs(root, command, ...args) {
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
    { encoding: "utf8" }
  );
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    assert.fail(`Docs Protocol did not return JSON. stderr: ${result.stderr}`);
  }
  return { envelope, status: result.status, stderr: result.stderr };
}

test("keeps protocol and frozen-document governance in every repository gate", async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    manifest.scripts["docs:protocol:check"],
    "pnpm docs:check && pnpm docs:governance && pnpm docs:qualification"
  );
  assert.equal(
    manifest.scripts["docs:governance"],
    "node --test scripts/docs/verify-frozen-document-bytes.test.mjs"
  );
  for (const gate of ["check", "check:fast"]) {
    assert.match(manifest.scripts[gate], /pnpm docs:protocol:check/u);
  }
  assert.equal(manifest.scripts["check:changed"], "agent-teams-foundation agent-workflow changed --consumer .");
});

test("qualifies Runtime authoring through the shared disposable runner", async () => {
  await disposableRepository(async (root) => {
    const receipt = await runDocsProtocolQualification({
      fixtureRoot: root,
      scenario: {
        find: {
          query: { id: "ADR-0001" },
          expectedIds: ["ADR-0001"]
        },
        newDocument: {
          intent: {
            type: "architecture",
            id: "runtime.architecture.disposable-protocol-qualification",
            title: "Disposable Protocol Qualification",
            owner: "architecture/tooling",
            summary: "Qualifies Runtime documentation without touching the real repository."
          },
          related: ["ADR-0001"]
        }
      }
    });
    assert.equal(receipt.projectId, "agent-runtime");
    assert.equal(
      receipt.appliedDocumentPath,
      "docs/architecture/disposable-protocol-qualification.md"
    );
    assert.deepEqual(receipt.checks, [
      "info",
      "find",
      "preview",
      "crash",
      "doctor",
      "recover",
      "receipt",
      "parent",
      "apply",
      "index",
      "check",
      "source-unchanged"
    ]);
  });
});

test("fails closed for an unknown owner", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "README.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "owner: architecture",
      "owner: architecture/unknown"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId === "document.catalog.metadata-invalid"
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});

test("fails closed for an unresolved relation", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "README.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "related:\n  - ADR-0001",
      "related:\n  - missing.document\n  - ADR-0001"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId === "docs.metadata.common-semantics"
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});

test("fails closed for a stale required code anchor", async () => {
  await disposableRepository(async (root) => {
    const target = join(root, "docs", "architecture", "foundation-adoption.md");
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replace(
      "pattern: architecture/foundation/**",
      "pattern: packages/missing-required-anchor.ts"
    ));

    const result = docs(root, "check");
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.outcome, "violation");
    assert.ok(
      result.envelope.diagnostics.some(({ ruleId }) =>
        ruleId.includes("anchor")
      ),
      JSON.stringify(result.envelope.diagnostics)
    );
  }, { attachTooling: true });
});
