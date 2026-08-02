import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { rustBoundaryEvidenceRecordV1 } from "../../rust-system-boundaries/evidence/evidence-record-schema.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string): Promise<string> =>
  readFile(join(repositoryRoot, path), "utf8");

test("Rust boundary evidence remains closed, indexed, and non-production", async () => {
  const [recordSource, docsIndex, traceability, readiness, experiment, gates, workflow] =
    await Promise.all([
      read(
        "experiments/rust-system-boundaries/evidence/main-aa76858-evidence.json",
      ),
      read("docs/README.md"),
      read("docs/architecture/evidence-traceability.md"),
      read("docs/architecture/readiness.md"),
      read("experiments/rust-system-boundaries/README.md"),
      read("docs/spikes/rust-system-boundaries-production-gates.md"),
      read(".github/workflows/rust-system-boundaries-release-drill.yml"),
    ]);

  const record = rustBoundaryEvidenceRecordV1.parse(JSON.parse(recordSource));
  assert.equal(record.source.revision, "aa7685867d5ccbaba7b4eb0f873566f46d676945");
  assert.deepEqual(
    record.runs.boundaryMatrix.jobs.map(({ runner }) => runner).sort(),
    ["macos-15", "ubuntu-24.04", "windows-2025"],
  );
  assert.deepEqual(record.disposition, {
    spike: "proven",
    production: "unqualified",
  });

  const assertionIds = new Set(record.assertions.map(({ id }) => id));
  assert.ok(assertionIds.has("SUPERVISOR-LIFETIME-CUSTODY"));
  assert.ok(assertionIds.has("LINUX-CREDENTIAL-SENTINELS"));
  assert.ok(assertionIds.has("WINDOWS-EXIT-259-LIVENESS"));

  assert.match(docsIndex, /rust-system-boundaries\/README\.md/u);
  assert.match(traceability, /Non-promoted feasibility evidence/u);
  assert.match(traceability, /main-aa76858-evidence\.json/u);
  assert.match(readiness, /SPIKE PROVEN/u);
  assert.match(readiness, /PRODUCTION GATE OPEN/u);
  assert.match(experiment, /Credential sentinel rejection/u);
  assert.match(gates, /trusted-main provenance/u);
  assert.match(workflow, /branches:\s*\n\s*- main\s*\n/u);
});
