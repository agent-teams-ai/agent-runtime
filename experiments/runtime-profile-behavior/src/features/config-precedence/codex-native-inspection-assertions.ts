import type {
  ObservationAssertion,
  ScenarioEvidence,
} from "../../model.ts";

interface InspectionExpectation {
  readonly trusted: boolean;
  readonly effectiveModel: string;
  readonly effectiveMcpArg: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const parseInspection = (
  evidence: ScenarioEvidence,
): Record<string, unknown> => {
  try {
    return record(JSON.parse(evidence.result.stdout));
  } catch {
    return {};
  }
};

export const codexNativeInspectionAssertions = (
  expectation: InspectionExpectation,
): ((evidence: ScenarioEvidence) => readonly ObservationAssertion[]) =>
  (evidence) => {
    const output = parseInspection(evidence);
    const config = record(output.config);
    const mcpServers = record(config.mcpServers);
    const sharedMcp = record(mcpServers.shared);
    const sharedArgs = Array.isArray(sharedMcp.args)
      ? sharedMcp.args
      : [];
    const layers = Array.isArray(output.layers) ? output.layers : [];
    const skills = Array.isArray(output.skills) ? output.skills : [];
    const notifications = Array.isArray(output.notifications)
      ? output.notifications
      : [];
    const trustWarning = notifications.some((value) => {
      const notification = record(value);
      return (
        notification.method === "configWarning" &&
        typeof notification.summary === "string" &&
        notification.summary.includes("until the project is trusted")
      );
    });
    const sharedSkillScopes = skills
      .filter((value) => record(value).name === "shared")
      .map((value) => record(value).scope)
      .sort();
    const hasProjectLayer = layers.some(
      (value) => record(value).type === "project",
    );

    return [
      {
        id: "codex.native-inspection-command-succeeded",
        passed: evidence.result.exitCode === 0,
        expected: 0,
        actual: evidence.result.exitCode,
      },
      {
        id: "codex.effective-model-respects-trust",
        passed: config.model === expectation.effectiveModel,
        expected: expectation.effectiveModel,
        actual: config.model,
      },
      {
        id: "codex.effective-mcp-respects-trust",
        passed: sharedArgs[0] === expectation.effectiveMcpArg,
        expected: expectation.effectiveMcpArg,
        actual: sharedArgs[0],
      },
      {
        id: "codex.discovered-project-layer-is-observable",
        passed: hasProjectLayer,
        expected: true,
        actual: hasProjectLayer,
      },
      {
        id: "codex.project-skills-load-independently-of-config-trust",
        passed:
          sharedSkillScopes.includes("repo") &&
          sharedSkillScopes.includes("user"),
        expected: ["repo", "user"],
        actual: sharedSkillScopes,
      },
      {
        id: "codex.trust-warning-is-explicit",
        passed: trustWarning === !expectation.trusted,
        expected: !expectation.trusted,
        actual: trustWarning,
      },
    ];
  };
