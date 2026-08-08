import type { CommandResult } from "../../model.ts";

const withStdout = (
  result: CommandResult,
  value: unknown,
): CommandResult => ({
  ...result,
  stdout: `${JSON.stringify(value, null, 2)}\n`,
});

const marker = (content: unknown): string | undefined => {
  if (typeof content !== "string") {
    return undefined;
  }
  return /Marker:\s*([^\n]+)/.exec(content)?.[1]?.trim();
};

export const normalizeOpenCodeSkillList = (
  result: CommandResult,
): CommandResult => {
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) {
      return result;
    }
    return withStdout(
      result,
      parsed
        .map((value) => value as Record<string, unknown>)
        .filter((skill) => skill.location !== "<built-in>")
        .map((skill) => ({
          name: skill.name,
          location: skill.location,
          marker: marker(skill.content),
        })),
    );
  } catch {
    return result;
  }
};

export const normalizeOpenCodeConfigUsername = (
  result: CommandResult,
): CommandResult => {
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return withStdout(result, {
      username: parsed.username,
      pluginCount: Array.isArray(parsed.plugin) ? parsed.plugin.length : 0,
      mcpNames:
        typeof parsed.mcp === "object" && parsed.mcp !== null
          ? Object.keys(parsed.mcp as Record<string, unknown>).toSorted()
          : [],
    });
  } catch {
    return result;
  }
};
