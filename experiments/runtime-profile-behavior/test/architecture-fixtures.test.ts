import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const readFixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(fixturesRoot, name), "utf8")) as Record<
    string,
    unknown
  >;

const records = (value: unknown): Record<string, unknown>[] => {
  assert.ok(Array.isArray(value));
  return value.map((item) => {
    assert.equal(typeof item, "object");
    assert.notEqual(item, null);
    return item as Record<string, unknown>;
  });
};

const assertUniqueIds = (items: readonly Record<string, unknown>[]): void => {
  const ids = items.map((item) => item.id);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
  assert.equal(new Set(ids).size, ids.length);
};

test("provider behavior observations are evidence-linked", async () => {
  const fixture = await readFixture("provider-behavior-matrix.json");
  assert.equal(fixture.schemaVersion, 1);
  const observations = records(fixture.observations);
  assertUniqueIds(observations);
  for (const observation of observations) {
    assert.match(String(observation.provider), /^(claude|codex|opencode)$/);
    assert.match(String(observation.status), /^(confirmed|limited|open)$/);
    assert.ok(recordsAsStrings(observation.evidenceRuns).length > 0);
  }
});

test("confirmed profile invariants remain separate from open decisions", async () => {
  const fixture = await readFixture("confirmed-invariants.json");
  const invariants = records(fixture.invariants);
  const decisions = records(fixture.openDecisions);
  const candidates = records(fixture.candidateDecisions);
  assertUniqueIds([...invariants, ...decisions, ...candidates]);
  assert.ok(invariants.every((item) => item.status === "confirmed"));
  assert.ok(decisions.length > 0);
  assert.ok(candidates.every((item) => item.status === "proposed"));
});

test("legacy disposition never copies a module into the new core unchanged", async () => {
  const fixture = await readFixture("opencode-legacy-disposition.json");
  const entries = records(fixture.entries);
  assertUniqueIds(entries);
  assert.ok(entries.every((entry) => entry.disposition !== "keep"));
  assert.ok(entries.some((entry) => entry.disposition === "do-not-migrate"));
  assert.ok(entries.some((entry) => entry.disposition === "adapt"));
  assert.ok(entries.some((entry) => entry.disposition === "rewrite"));
});

test("promoted traces contain compact redacted evidence only", async () => {
  const fixture = await readFixture("redacted-trace-summaries.json");
  const scenarios = records(fixture.scenarios);
  assert.ok(scenarios.length >= 30);
  assertUniqueIds(
    scenarios.map((scenario) => ({
      id: `${String(scenario.runId)}:${String(scenario.scenarioId)}`,
    })),
  );

  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /"(?:stdout|stderr|environment)"\s*:/i);
  assert.doesNotMatch(serialized, /\/var\/data\/|\/root\//);
  assert.doesNotMatch(serialized, /\bBearer\s+(?!<REDACTED>)/i);
  assert.doesNotMatch(serialized, /-----BEGIN [^-]*PRIVATE KEY-----/);
  assert.ok(
    scenarios.every((scenario) =>
      /^[a-f0-9]{64}$/.test(String(scenario.sourceEvidenceSha256)),
    ),
  );
});

const recordsAsStrings = (value: unknown): readonly string[] => {
  assert.ok(Array.isArray(value));
  assert.ok(value.every((item) => typeof item === "string"));
  return value as string[];
};
