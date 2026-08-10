import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const executable = process.argv[2];
const workspace = process.argv[3];
const repetitions = Number(process.argv[4] ?? "50");
if (executable === undefined || workspace === undefined) {
  throw new Error("Expected OpenCode executable and workspace path");
}

const distribution = new Map<string, number>();
const failures: Array<{ iteration: number; reason: string }> = [];

for (let iteration = 0; iteration < repetitions; iteration += 1) {
  try {
    const { stdout } = await execFileAsync(
      executable,
      ["debug", "skill", "--pure"],
      {
        cwd: workspace,
        env: process.env,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const skills = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const shared = skills.find((skill) => skill.name === "shared");
    const content = typeof shared?.content === "string" ? shared.content : "";
    const observedMarker =
      /Marker:\s*([^\n]+)/.exec(content)?.[1]?.trim() ?? "<missing>";
    const location =
      typeof shared?.location === "string" ? shared.location : "<missing>";
    const key = `${observedMarker}|${location}`;
    distribution.set(key, (distribution.get(key) ?? 0) + 1);
  } catch (error) {
    failures.push({
      iteration,
      reason: error instanceof Error ? error.message.slice(0, 500) : "unknown",
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      repetitions,
      failures,
      distribution: [...distribution.entries()]
        .map(([key, count]) => {
          const [observedMarker, location] = key.split("|", 2);
          return { observedMarker, location, count };
        })
        .toSorted((left, right) =>
          String(left.observedMarker).localeCompare(String(right.observedMarker)),
        ),
    },
    null,
    2,
  )}\n`,
);
