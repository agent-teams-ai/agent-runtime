import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

test("packed root and composition entrypoints preserve consumer type compatibility", t => {
  const sandbox = mkdtempSync(join(tmpdir(), "provider-access-packed-consumer-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const archives = join(sandbox, "archives");
  mkdirSync(archives);
  const pnpmEntrypoint = process.env.npm_execpath;
  const pack = pnpmEntrypoint === undefined
    ? { command: "corepack", args: ["pnpm", "pack", "--pack-destination", archives] }
    : { command: process.execPath, args: [pnpmEntrypoint, "pack", "--pack-destination", archives] };
  execFileSync(pack.command, pack.args, { cwd: packageRoot, encoding: "utf8" });
  const archiveNames = readdirSync(archives).filter(name => name.endsWith(".tgz"));
  assert.equal(archiveNames.length, 1);
  const archive = join(archives, archiveNames[0] ?? "missing.tgz");
  const members = execFileSync("tar", ["tzf", archive], { encoding: "utf8" }).trim().split("\n");
  assert.ok(members.includes("package/dist/index.d.ts"));
  assert.ok(members.includes("package/dist/composition.d.ts"));
  assert.equal(members.some(name => name.startsWith("package/src/")), false);

  const installed = join(sandbox, "consumer", "node_modules", "@agent-teams", "provider-access");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["xzf", archive, "--strip-components=1", "-C", installed]);
  const consumer = join(sandbox, "consumer");
  const nodeTypes = join(consumer, "node_modules", "@types", "node");
  mkdirSync(join(consumer, "node_modules", "@types"), { recursive: true });
  symlinkSync(join(repositoryRoot, "node_modules", "@types", "node"), nodeTypes, "dir");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "provider-access-consumer", private: true, type: "module" }));
  const fixture = join(consumer, "consumer.ts");
  writeFileSync(fixture, `
import { OrdinaryPaUnavailable, type ProviderAccessProvider } from "@agent-teams/provider-access";
import {
  createContainedTurnCredentialMaterializationAuthorizationV1,
  createPostgresCredentialRenderingOwner,
  createPostgresDispatchConsumption,
  type CredentialGenerationAcquisition,
  type CredentialRecipe,
  type CredentialRenderingSelection,
  type MaterializationAuthorizationRepository,
  type MaterializationAuthorizationTransaction,
  type MaterializationPostgresClient,
  type MaterializationPostgresPool,
  type PostgresCredentialRenderingOwner,
} from "@agent-teams/provider-access/composition";

const provider: ProviderAccessProvider = "codex";
const client = {
  async query(_sql: string) { return { rows: [], rowCount: 0 }; },
  release(_discard?: boolean) {},
} satisfies MaterializationPostgresClient;
const pool = { async connect() { return client; } } satisfies MaterializationPostgresPool;
const acquisition: CredentialGenerationAcquisition = {
  async acquire(request, signal) {
    void request.authorization;
    void signal.aborted;
    return { kind: "unsupported" };
  },
};
const selection: CredentialRenderingSelection = {
  operationRef: "operation:one",
  binding: {
    accessRef: "access:one", availability: "available", bindingRevision: 1,
    credentialBindingDigest: "digest:one", credentialBindingRef: "binding:one", credentialGeneration: 1,
    projectId: "project:one", provider, providerAccountRef: "account:one", providerRouteRef: "route:one",
    revocation: "active", scopeDigest: "scope:one", tenantId: "tenant:one",
  },
  recipe: "codex-api",
  operationAbortSignal: new AbortController().signal,
  deadline: performance.now() + 1_000,
};
const owner: Readonly<PostgresCredentialRenderingOwner> =
  createPostgresCredentialRenderingOwner(pool, selection, acquisition, { statementMs: 50 });
const dispatchOwner = createPostgresDispatchConsumption(pool, { statementMs: 50 });
owner.control.materialAdmission?.admit({
  operationRef: selection.operationRef,
  binding: selection.binding,
  recipe: selection.recipe,
  fields: [{ name: "apiKey", valueBytes: new Uint8Array([1]) }],
});

const repository: MaterializationAuthorizationRepository = {
  async observeAuthorizationRequest() { return undefined; },
  async transact(_selector, work) {
    const transaction: MaterializationAuthorizationTransaction = {
      async findAuthorizationRequest() { return undefined; },
      async findBinding() { return undefined; },
      async saveAuthorization(receipt) { void receipt.decision; },
    };
    return work(transaction);
  },
};
createContainedTurnCredentialMaterializationAuthorizationV1({
  digest: { async digest(payload) { return payload; } },
  repository,
});
new OrdinaryPaUnavailable();

// @ts-expect-error recipes are a closed literal union
const badRecipe: CredentialRecipe = "ambient-credential";
// @ts-expect-error trusted selections are immutable snapshots
selection.operationRef = "operation:two";
// @ts-expect-error supported PostgreSQL controls are immutable capabilities
dispatchOwner.control.publishHead = dispatchOwner.control.publishHead;
// @ts-expect-error supported PostgreSQL controls are immutable capabilities
dispatchOwner.control.advanceControlTime = dispatchOwner.control.advanceControlTime;
// @ts-expect-error supported PostgreSQL controls are immutable capabilities
dispatchOwner.control.observeHead = dispatchOwner.control.observeHead;
void badRecipe;
void owner;
void dispatchOwner;
`);
  const compiler = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");
  try {
    execFileSync(process.execPath, [compiler, "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--skipLibCheck", "false", "--types", "node",
      "--typeRoots", join(consumer, "node_modules", "@types"), fixture], { cwd: consumer, encoding: "utf8" });
  } catch (error) {
    const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
    throw new Error(`packed consumer compilation failed:\n${output}`, { cause: error });
  }
  const entrypoints = ["@agent-teams/provider-access", "@agent-teams/provider-access/composition"];
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const entries=${JSON.stringify(entrypoints)}; for (const entry of entries) await import(entry); console.log(entries.length);`],
  { cwd: consumer, encoding: "utf8" });
  assert.equal(output.trim(), "2");
  assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).name, "@agent-teams/provider-access");
});
