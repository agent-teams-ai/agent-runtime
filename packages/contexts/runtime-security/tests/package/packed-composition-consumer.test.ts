import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

test("packed root and composition entrypoints preserve consumer type compatibility", t => {
  const sandbox = mkdtempSync(join(tmpdir(), "runtime-security-packed-consumer-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const archives = join(sandbox, "archives");
  mkdirSync(archives);
  const pnpmEntrypoint = process.env.npm_execpath;
  const pack = pnpmEntrypoint === undefined
    ? { command: "corepack", args: ["pnpm", "pack", "--pack-destination", archives] }
    : {
        command: process.execPath,
        args: [pnpmEntrypoint, "pack", "--pack-destination", archives],
      };
  execFileSync(pack.command, pack.args, { cwd: packageRoot, encoding: "utf8" });
  const archiveNames = readdirSync(archives).filter(name => name.endsWith(".tgz"));
  assert.equal(archiveNames.length, 1);
  const archive = join(archives, archiveNames[0] ?? "missing.tgz");
  const members = execFileSync("tar", ["tzf", archive], { encoding: "utf8" })
    .trim().split("\n");
  assert.ok(members.includes("package/dist/index.d.ts"));
  assert.ok(members.includes("package/dist/composition.d.ts"));
  assert.equal(members.some(name => name.startsWith("package/src/")), false);

  const consumer = join(sandbox, "consumer");
  const installed = join(consumer, "node_modules", "@agent-teams", "runtime-security");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["xzf", archive, "--strip-components=1", "-C", installed]);
  const dependencies = join(installed, "node_modules", "@agent-teams");
  mkdirSync(dependencies, { recursive: true });
  symlinkSync(
    join(repositoryRoot, "packages", "platform", "filesystem-custody"),
    join(dependencies, "filesystem-custody"),
    "dir",
  );
  const nodeTypes = join(consumer, "node_modules", "@types", "node");
  mkdirSync(join(consumer, "node_modules", "@types"), { recursive: true });
  symlinkSync(join(repositoryRoot, "node_modules", "@types", "node"), nodeTypes, "dir");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "runtime-security-consumer",
    private: true,
    type: "module",
  }));

  const fixture = join(consumer, "consumer.ts");
  writeFileSync(fixture, `
import type { ContainedTurnDispatchAuthorityV1 } from "@agent-teams/runtime-security";
import {
  createContainedTurnDispatchAuthorityFeature,
  createPostgresDispatchConsumptionRepository,
  type DispatchConsumptionRepository,
  type DispatchPgClient,
  type DispatchPgPool,
  type DispatchPublicationKey,
  type PostgresDispatchAuthorityChange,
  type PostgresDispatchConsumptionRepository,
} from "@agent-teams/runtime-security/composition";
// @ts-expect-error operation selector is private to Runtime Security
import type { OperationKey } from "@agent-teams/runtime-security/composition";

const client = {
  async query(_sql: string, _values?: unknown[]) {
    return { rows: [] as Record<string, unknown>[], rowCount: 0 };
  },
  release(_discard?: boolean) {},
} satisfies DispatchPgClient;
const pool = { async connect() { return client; } } satisfies DispatchPgPool;
const digest = { digestCanonical(value: string) { return value; } };
const postgres: PostgresDispatchConsumptionRepository =
  createPostgresDispatchConsumptionRepository({
    pool, digest, connectTimeoutMs: 50, queryTimeoutMs: 50, transactionTimeoutMs: 100,
  });
const key: DispatchPublicationKey = {
  scope: { tenantId: "tenant", projectId: "project", scopeDigest: "scope" },
  providerId: "provider", authorityGeneration: "generation", operationId: "operation",
};
const changed: Promise<PostgresDispatchAuthorityChange> = postgres.revokeAuthority(key, "0");

const repository: DispatchConsumptionRepository = {
  async consumeAtomically(_key, decide) { return decide({}).outcome; },
  async observe() { return undefined; },
  async settleAtomically(_key, decide) { return decide({}).result; },
};
const feature = createContainedTurnDispatchAuthorityFeature({
  repository,
  clock: { now() { return 1; } },
  digest,
});
const authority: ContainedTurnDispatchAuthorityV1 = feature.dispatchAuthorityV1;

// @ts-expect-error status is a closed compare-and-swap outcome
const invalidChange: PostgresDispatchAuthorityChange = { status: "replaced", headVersion: "1" };
// @ts-expect-error supported snapshots are readonly
key.operationId = "other-operation";
void authority;
void changed;
void invalidChange;
`);
  const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  try {
    execFileSync(process.execPath, [
      compiler,
      "--noEmit",
      "--strict",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--skipLibCheck", "false",
      "--types", "node",
      "--typeRoots", join(consumer, "node_modules", "@types"),
      fixture,
    ], { cwd: consumer, encoding: "utf8" });
  } catch (error) {
    const output = error instanceof Error && "stdout" in error
      ? String(error.stdout)
      : String(error);
    throw new Error(`packed consumer compilation failed:\n${output}`, { cause: error });
  }

  const entrypoints = [
    "@agent-teams/runtime-security",
    "@agent-teams/runtime-security/composition",
  ];
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `const entries=${JSON.stringify(entrypoints)}; for (const entry of entries) await import(entry); console.log(entries.length);`,
  ], { cwd: consumer, encoding: "utf8" });
  assert.equal(output.trim(), "2");
  assert.equal(
    JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).name,
    "@agent-teams/runtime-security",
  );
});
