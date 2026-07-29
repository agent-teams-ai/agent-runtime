import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScenarioEvidence } from "../../model.ts";
import { copiedCredentialScenario } from "../credential-routes/scenarios.ts";
import type { ProbeScenario } from "../scenario-execution/scenario.ts";

const codexConcurrencyProbe = fileURLToPath(
  new URL("./codex-concurrency-probe.ts", import.meta.url),
);
const codexCrashResumeProbe = fileURLToPath(
  new URL("./codex-crash-resume-probe.ts", import.meta.url),
);
const codexResumeProbe = fileURLToPath(
  new URL("./codex-resume-probe.ts", import.meta.url),
);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const resumeAssertions = (strictRuntime: boolean) =>
  (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const first = record(output.first);
  const resumed = record(output.resumed);
  return [
    {
      id: "codex.lifecycle-probe-succeeded",
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: "codex.initial-session-completed",
      passed:
        first.exitCode === 0 &&
        first.finalText === "runtime-profile-start-ok",
      expected: "runtime-profile-start-ok",
      actual: first.finalText,
    },
    {
      id: "codex.resume-completed",
      passed:
        resumed.exitCode === 0 &&
        resumed.finalText === "runtime-profile-resume-ok",
      expected: "runtime-profile-resume-ok",
      actual: resumed.finalText,
    },
    {
      id: "codex.resume-preserves-provider-thread",
      passed: output.sameThread === true,
      expected: true,
      actual: output.sameThread,
    },
    {
      id: "codex.resume-has-durable-session-state",
      passed:
        typeof output.persistedSessionEntries === "number" &&
        output.persistedSessionEntries > 0,
      expected: "> 0",
      actual: output.persistedSessionEntries,
    },
    {
      id: "codex.strict-runtime-skips-plugin-catalog",
      passed:
        !strictRuntime || output.pluginCatalogMaterialized === false,
      expected: strictRuntime ? false : "not asserted",
      actual: output.pluginCatalogMaterialized,
    },
  ];
};

const concurrencyAssertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const first = record(output.first);
  const second = record(output.second);
  return [
    {
      id: "codex.concurrent-processes-succeeded",
      passed:
        evidence.result.exitCode === 0 &&
        first.exitCode === 0 &&
        second.exitCode === 0,
      expected: [0, 0],
      actual: [first.exitCode, second.exitCode],
    },
    {
      id: "codex.concurrent-process-a-returned-marker",
      passed: first.finalText === "runtime-profile-concurrent-a-ok",
      expected: "runtime-profile-concurrent-a-ok",
      actual: first.finalText,
    },
    {
      id: "codex.concurrent-process-b-returned-marker",
      passed: second.finalText === "runtime-profile-concurrent-b-ok",
      expected: "runtime-profile-concurrent-b-ok",
      actual: second.finalText,
    },
    {
      id: "codex.concurrent-processes-have-distinct-threads",
      passed: output.distinctThreads === true,
      expected: true,
      actual: output.distinctThreads,
    },
    {
      id: "codex.concurrent-processes-persisted-session-state",
      passed:
        typeof first.persistedSessionEntries === "number" &&
        first.persistedSessionEntries > 0 &&
        typeof second.persistedSessionEntries === "number" &&
        second.persistedSessionEntries > 0,
      expected: ["> 0", "> 0"],
      actual: [first.persistedSessionEntries, second.persistedSessionEntries],
    },
  ];
};

const crashResumeAssertions = (evidence: ScenarioEvidence) => {
  let output: Record<string, unknown> = {};
  try {
    output = record(JSON.parse(evidence.result.stdout));
  } catch {
    output = {};
  }
  const results = Array.isArray(output.results)
    ? output.results.map(record)
    : [];
  return [
    {
      id: "codex.crash-resume-probe-succeeded",
      passed: evidence.result.exitCode === 0,
      expected: 0,
      actual: evidence.result.exitCode,
    },
    {
      id: "codex.crash-resume-all-repetitions-recovered",
      passed:
        output.allRecovered === true &&
        results.length === output.repetitions,
      expected: true,
      actual: {
        allRecovered: output.allRecovered,
        repetitions: output.repetitions,
        resultCount: results.length,
      },
    },
  ];
};

export const providerLifecycleScenarios = (): readonly ProbeScenario[] => {
  const credentialRoot = join(process.cwd(), ".spike", "credential-sources");
  const scenario = (
    id: string,
    strictRuntime: boolean,
  ): ProbeScenario =>
    copiedCredentialScenario({
      id,
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: process.execPath,
        args: [
          codexResumeProbe,
          sandbox.workspace,
          ...(strictRuntime ? ["strict"] : []),
        ],
        cwd: sandbox.workspace,
        timeoutMs: 130_000,
        trace: false,
      }),
      assertions: resumeAssertions(strictRuntime),
    });

  return [
    scenario("codex-persisted-session-resume-default", false),
    scenario("codex-persisted-session-resume-strict", true),
    copiedCredentialScenario({
      id: "codex-concurrent-shared-profile",
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: process.execPath,
        args: [codexConcurrencyProbe, sandbox.workspace, "shared"],
        cwd: sandbox.workspace,
        timeoutMs: 70_000,
        trace: false,
      }),
      assertions: concurrencyAssertions,
    }),
    copiedCredentialScenario({
      id: "codex-concurrent-isolated-profiles",
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: process.execPath,
        args: [codexConcurrencyProbe, sandbox.workspace, "isolated"],
        cwd: sandbox.workspace,
        timeoutMs: 70_000,
        trace: false,
      }),
      assertions: concurrencyAssertions,
    }),
    copiedCredentialScenario({
      id: "codex-crash-after-thread-started-resume",
      provider: "codex",
      source: join(credentialRoot, "codex-auth.json"),
      destination: (sandbox) => join(sandbox.codexHome, "auth.json"),
      invocation: (sandbox) => ({
        executable: process.execPath,
        args: [codexCrashResumeProbe, sandbox.workspace, "5"],
        cwd: sandbox.workspace,
        timeoutMs: 180_000,
        trace: false,
      }),
      assertions: crashResumeAssertions,
    }),
  ];
};
