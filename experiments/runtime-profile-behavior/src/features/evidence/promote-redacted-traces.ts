import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { redactText } from "../redaction/redact.ts";
import { writeJsonEvidence } from "./write-evidence.ts";

const fixturesRoot = join(
  process.cwd(),
  "experiments",
  "runtime-profile-behavior",
  "fixtures",
);
const runRoot = join(process.cwd(), ".spike", "runs");
const selectionPath = join(fixturesRoot, "redacted-trace-selection.json");
const outputPath = join(fixturesRoot, "redacted-trace-summaries.json");
const OMITTED_FIELD =
  /^(?:apiKey|accessToken|authorization|auth|credential|credentials|environment|password|refreshToken|secret|stderr|stdout|token)$|(?:error|message)$/i;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const compact = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return "<DEPTH_LIMIT>";
  }
  if (typeof value === "string") {
    return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}<TRUNCATED>`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => compact(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OMITTED_FIELD.test(key))
        .slice(0, 30)
        .map(([key, item]) => [key, compact(item, depth + 1)]),
    );
  }
  return value;
};

const pathSummary = (value: unknown): object => {
  const paths = strings(value);
  return { count: paths.length, samples: paths.slice(0, 20) };
};

const fileMutationSummary = (value: unknown): object => {
  const entries = Array.isArray(value) ? value.map(record) : [];
  return {
    count: entries.length,
    samples: entries
      .slice(0, 20)
      .map((entry) => entry.path ?? record(entry.after).path ?? null),
  };
};

const scenarioSummary = (
  runId: string,
  sourcePath: string,
  sourceText: string,
): object => {
  const source = record(JSON.parse(sourceText) as unknown);
  const result = record(source.result);
  const filesystem = record(source.filesystem);
  const trace = record(source.trace);
  const base = {
    runId,
    sourcePath,
    sourceEvidenceSha256: createHash("sha256").update(sourceText).digest("hex"),
    scenarioId:
      source.scenarioId ??
      (typeof source.provider === "string"
        ? `${source.provider}-managed-policy`
        : "cross-system"),
    provider: source.provider ?? "cross-system",
    capturedAt: source.capturedAt,
    assertions: compact(source.assertions),
  };

  if (Object.keys(result).length === 0) {
    return {
      ...base,
      sourceRevisions: compact(source.sourceRevisions),
      targetInvariantEvaluation: compact(source.targetInvariantEvaluation),
      observation: compact(source.observation),
    };
  }

  return {
    ...base,
    command: compact(source.command),
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
    filesystem: {
      added: fileMutationSummary(filesystem.added),
      removed: fileMutationSummary(filesystem.removed),
      changed: fileMutationSummary(filesystem.changed),
    },
    trace: {
      reads: pathSummary(trace.readPaths),
      writes: pathSummary(trace.writePaths),
      executions: pathSummary(trace.executePaths),
      traceFileCount: trace.traceFileCount,
    },
    safety: compact(source.safety),
    verification: compact(source.verification),
  };
};

const selection = record(
  JSON.parse(await readFile(selectionPath, "utf8")) as unknown,
);
const summaries: object[] = [];

for (const runId of strings(selection.runIds)) {
  const manifestPath = join(runRoot, runId, "manifest.json");
  const manifest = record(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  for (const evidencePath of strings(manifest.evidence)) {
    const sourcePath = join(runRoot, runId, evidencePath);
    const sourceText = await readFile(sourcePath, "utf8");
    summaries.push(scenarioSummary(runId, evidencePath, sourceText));
  }
}

const promoted = {
  schemaVersion: 1,
  generatedFrom: strings(selection.runIds),
  scenarios: summaries,
};
const redacted = redactText(JSON.stringify(promoted), {
  roots: {
    WORKTREE: process.cwd(),
    RUN_ROOT: runRoot,
  },
});
await writeJsonEvidence(outputPath, JSON.parse(redacted) as unknown);
