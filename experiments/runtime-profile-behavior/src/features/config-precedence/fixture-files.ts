import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const writeFixture = async (
  path: string,
  content: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
};

export const writeJsonFixture = async (
  path: string,
  value: unknown,
): Promise<void> => {
  await writeFixture(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const writeSkillFixture = async (
  path: string,
  name: string,
  marker: string,
): Promise<void> => {
  await writeFixture(
    path,
    [
      "---",
      `name: ${name}`,
      `description: Runtime profile spike marker ${marker}.`,
      "---",
      "",
      `# ${name}`,
      "",
      `Marker: ${marker}`,
      "",
    ].join("\n"),
  );
};

export const mcpMarker = (marker: string): object => ({
  type: "stdio",
  command: "/bin/echo",
  args: [marker],
  env: {},
});
