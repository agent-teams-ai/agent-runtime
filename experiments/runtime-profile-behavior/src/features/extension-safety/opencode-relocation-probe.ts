import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { join } from "node:path";

const [executable, fixtureRoot] = process.argv.slice(2);
if (!executable || !fixtureRoot) {
  throw new Error("opencode executable and fixture root are required");
}

const original = join(fixtureRoot, "workspace");
const relocated = join(fixtureRoot, "relocated-workspace");

const inspect = (cwd: string): unknown =>
  JSON.parse(
    execFileSync(executable, ["debug", "skill"], {
      cwd,
      env: process.env,
      encoding: "utf8",
      timeout: 20_000,
    }),
  ) as unknown;

const summarize = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value
        .map((item) => item as Record<string, unknown>)
        .filter((item) => item.location !== "<built-in>")
        .map((item) => ({
          id: item.name ?? item.id,
          location: item.location,
          marker:
            typeof item.content === "string"
              ? /Marker:\s*([^\n]+)/.exec(item.content)?.[1]?.trim() ?? null
              : null,
        }))
    : [];

const before = summarize(inspect(original));
await cp(original, relocated, { recursive: true });
const after = summarize(inspect(relocated));

process.stdout.write(
  `${JSON.stringify({
    before: before.map((item) => ({
      ...item,
      location: String(item.location).replace(fixtureRoot, "<fixture>"),
    })),
    after: after.map((item) => ({
      ...item,
      location: String(item.location).replace(fixtureRoot, "<fixture>"),
    })),
  })}\n`,
);
