import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ComparisonFixture, TargetInvariantEvaluation } from "./types.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const skillIds = async (root: string): Promise<readonly string[]> => {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
};

const mcpNames = async (path: string): Promise<readonly string[]> => {
  const value = JSON.parse(await readFile(path, "utf8")) as {
    mcp?: Record<string, unknown>;
  };
  return Object.keys(value.mcp ?? {}).toSorted();
};

export const evaluateTargetInvariants = async (
  fixture: ComparisonFixture,
): Promise<TargetInvariantEvaluation> => {
  const sourcePaths = [
    join(fixture.xdgConfig, "opencode", "opencode.json"),
    join(fixture.xdgConfig, "opencode", "opencode.jsonc"),
    join(fixture.workspace, "opencode.json"),
    join(fixture.xdgConfig, "opencode", "skills", "duplicate-skill", "SKILL.md"),
    join(fixture.workspace, ".opencode", "skills", "duplicate-skill", "SKILL.md"),
  ];
  const sourceRevision = hash(
    (
      await Promise.all(
        sourcePaths.map(async (path) =>
          `${relative(fixture.root, path)}:${hash(await readFile(path, "utf8"))}`,
        ),
      )
    )
      .toSorted()
      .join("\n"),
  );
  const [globalSkills, projectSkills, globalMcp, projectMcp] =
    await Promise.all([
      skillIds(join(fixture.xdgConfig, "opencode", "skills")),
      skillIds(join(fixture.workspace, ".opencode", "skills")),
      mcpNames(join(fixture.xdgConfig, "opencode", "opencode.json")),
      mcpNames(join(fixture.workspace, "opencode.json")),
    ]);
  const duplicateSkillIds = globalSkills.filter((id) =>
    projectSkills.includes(id),
  );
  const duplicateMcpNames = globalMcp.filter((id) => projectMcp.includes(id));
  const diagnostics = [
    ...duplicateSkillIds.map(
      (id) => `AMBIGUOUS_SKILL_ID:${id}:explicit override required`,
    ),
    ...duplicateMcpNames.map(
      (id) => `MCP_OVERRIDE:${id}:record winning source in manifest`,
    ),
  ];
  return {
    accepted: duplicateSkillIds.length === 0,
    sourceRevision,
    duplicateMcpNames,
    duplicateSkillIds,
    diagnostics,
  };
};
