import { execFile as execFileCallback } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const configuredFoundationCli = process.env.FOUNDATION_CLI_PATH;
const foundationCli =
  configuredFoundationCli === undefined
    ? join(
        repositoryRoot,
        "node_modules/@agent-teams/engineering-foundation/dist/cli.js",
      )
    : resolve(configuredFoundationCli);
const localTsc = join(
  repositoryRoot,
  "node_modules/.bin",
  process.platform === "win32" ? "tsc.CMD" : "tsc",
);
const pnpmEntrypoint = process.env.npm_execpath;
const configurationPath = "architecture/foundation/scaffolding.yaml";
const targetIds = [
  "agent-execution",
  "provider-access",
  "runtime-configuration",
  "runtime-security",
];
const authorityInputs = [
  configurationPath,
  "architecture/foundation/scaffold-targets.yaml",
  "architecture/foundation/scaffold-tsconfig.json",
  "docs/decisions/0005-runtime-context-package-identities.md",
  "pnpm-workspace.yaml",
];

const run = async (executable, args, cwd, environment = process.env) => {
  const result = await execFile(executable, args, {
    cwd,
    env: environment,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  return result.stdout;
};

const copyRepositoryFile = async (temporaryRoot, repositoryPath) => {
  const destination = join(temporaryRoot, repositoryPath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(repositoryRoot, repositoryPath), destination);
};

const planAndApplyTarget = async (temporaryRoot, targetId) => {
  const intentPath = `architecture/foundation/scaffold-intents/${targetId}.yaml`;
  await copyRepositoryFile(temporaryRoot, intentPath);
  const planSource = await run(
    process.execPath,
    [
      foundationCli,
      "scaffold-plan",
      intentPath,
      "--consumer",
      temporaryRoot,
      "--config",
      configurationPath,
      "--json",
    ],
    repositoryRoot,
  );
  const planPath = join(temporaryRoot, "plans", `${targetId}.json`);
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(JSON.parse(planSource), null, 2)}\n`);
  await run(
    process.execPath,
    [
      foundationCli,
      "scaffold-apply",
      `plans/${targetId}.json`,
      "--consumer",
      temporaryRoot,
      "--json",
    ],
    temporaryRoot,
  );
};

const checkGeneratedPackage = async (temporaryRoot, targetId) => {
  if (pnpmEntrypoint === undefined) {
    throw new Error("Scaffolding verification must run through the pinned pnpm command.");
  }
  const packageRoot = join(temporaryRoot, "packages/contexts", targetId);
  const environment = {
    ...process.env,
    PATH: `${join(repositoryRoot, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  await run(process.execPath, [pnpmEntrypoint, "run", "check"], packageRoot, environment);
};

const main = async () => {
  await access(foundationCli);
  await access(localTsc);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ar-foundation-scaffold-"));
  try {
    for (const repositoryPath of authorityInputs) {
      await copyRepositoryFile(temporaryRoot, repositoryPath);
    }
    await symlink(
      join(repositoryRoot, "node_modules"),
      join(temporaryRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const targetId of targetIds) {
      await planAndApplyTarget(temporaryRoot, targetId);
      await checkGeneratedPackage(temporaryRoot, targetId);
    }
    process.stdout.write(
      `Foundation scaffolding verified: ${targetIds.length} synthetic packages planned, applied, and checked.\n`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

await main();
