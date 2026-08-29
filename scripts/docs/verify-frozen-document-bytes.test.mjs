import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

import {
  FrozenDocumentError,
  readFrozenDigestAuthority,
  verifyFrozenDocumentBytes
} from "./verify-frozen-document-bytes.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const inlineMetadataPaths = [
  "docs/README.md",
  "docs/architecture/README.md",
  "docs/architecture/architecture-foundation.md",
  "docs/architecture/communication-boundaries.md",
  "docs/architecture/evidence-traceability.md",
  "docs/architecture/execution-generation-model.md",
  "docs/architecture/foundation-adoption.md",
  "docs/architecture/opencode-integration.md",
  "docs/architecture/readiness.md",
  "docs/decisions/README.md",
  "docs/decisions/0006-orthogonal-runtime-operation-state-and-effect-continuity.md",
  "docs/decisions/0007-deterministic-documentation-governance.md",
  "docs/decisions/0008-private-embedded-runtime-access-entrypoint.md",
  "docs/decisions/0009-contained-turn-private-access-and-host-shutdown-boundary.md",
  "docs/decisions/0010-contained-agent-turn-v1-operation-authority.md",
  "docs/decisions/0012-provider-access-authority-in-contained-turn-composition.md",
  "docs/spikes/rust-system-boundaries-production-gates.md"
];

function scalarMetadata(source, indentation) {
  const prefix = " ".repeat(indentation);
  const result = {};
  for (const key of ["id", "type", "status", "owner"]) {
    const match = new RegExp(`^${prefix}${key}: ([^\\r\\n]+)$`, "mu").exec(source);
    assert.notEqual(match, null, `missing ${key}`);
    result[key] = match[1];
  }
  return result;
}

function increment(counter, value) {
  counter.set(value, (counter.get(value) ?? 0) + 1);
}

test("committed frozen authority preserves all evidence bytes", async () => {
  assert.equal(await verifyFrozenDocumentBytes(repositoryRoot), 37);
});

test("catalog authority has the reviewed type and lifecycle census", async () => {
  const sidecar = await readFile(join(repositoryRoot, "docs/document-metadata.yaml"), "utf8");
  const sidecarBlocks = sidecar.split(/^  (?=docs\/)/mu).slice(1);
  assert.equal(sidecarBlocks.length, 37);
  const metadata = sidecarBlocks.map((block) => scalarMetadata(block, 4));
  for (const path of inlineMetadataPaths) {
    metadata.push(scalarMetadata(await readFile(join(repositoryRoot, path), "utf8"), 0));
  }

  assert.equal(metadata.length, 54);
  assert.equal(new Set(metadata.map((entry) => entry.id)).size, 54);
  const types = new Map();
  const statuses = new Map();
  for (const entry of metadata) {
    increment(types, entry.type);
    increment(statuses, entry.status);
  }
  assert.deepEqual(Object.fromEntries(types), {
    adr: 11,
    evidence: 32,
    index: 3,
    architecture: 7,
    "qualification-plan": 1
  });
  assert.deepEqual(Object.fromEntries(statuses), {
    accepted: 15,
    "evidence-reference": 31,
    superseded: 1,
    active: 5,
    proposed: 2
  });
});

test("frozen authority rejects an incomplete path set", async () => {
  assert.throws(
    () => readFrozenDigestAuthority("contract: foundation.document-metadata-sidecar/v1\ndocuments: {}\n"),
    (error) => error instanceof FrozenDocumentError && /must contain 37 paths/u.test(error.message)
  );
});

test("frozen verification fails closed after byte drift in a disposable fixture", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "agent-runtime-docs-"));
  const sidecarSource = await readFile(join(repositoryRoot, "docs/document-metadata.yaml"), "utf8");
  await mkdir(join(fixture, "docs"), { recursive: true });
  await writeFile(join(fixture, "docs/document-metadata.yaml"), sidecarSource, "utf8");

  const authority = readFrozenDigestAuthority(sidecarSource);
  for (const path of authority.keys()) {
    const destination = join(fixture, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(join(repositoryRoot, path)));
  }
  const first = authority.keys().next().value;
  assert.equal(typeof first, "string");
  await writeFile(join(fixture, first), "tampered\n", "utf8");

  await assert.rejects(
    verifyFrozenDocumentBytes(fixture),
    (error) => error instanceof FrozenDocumentError && /digest mismatch/u.test(error.message)
  );
});
