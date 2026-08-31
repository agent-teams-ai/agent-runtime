import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  createContainedTurnFeature,
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
} from "../dist/composition.js";
import { createCodexAppServerPermissionBoundary } from "../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { createClaudeAgentSdkPrivateProjection } from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import { applyContainedTurnPostgresSchema } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/contained-turn-postgres-schema.js";
import { PostgresContainedTurnOperationStore } from "../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { CONTAINED_TURN_REQUIRED_PROOF_KINDS } from "../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import { createDependencies } from "./features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

const databaseUrl = process.env.POSTGRES_DURABILITY_URL;
const postgresTest = databaseUrl === undefined ? test.skip : test;

class FakeHost {
  readonly plans: any[] = [];
  readonly refs = new Set<string>();
  containments = 0;
  releases = 0;
  reserves = 0;
  starts = 0;
  async reserve(input: any) {
    this.reserves += 1;
    const custodyRef = `urn:agent-runtime:host-custody:pg-random-${String(this.reserves)}`;
    this.refs.add(custodyRef);
    this.plans.push(input.launchPlan);
    return Object.freeze({ custodyRef });
  }
  async open() {throw new Error("current-owner PostgreSQL integration must reserve");}
  start(custodyRef: string) {
    assert.ok(this.refs.has(custodyRef));
    this.starts += 1;
    return Object.freeze({
      exitCode: null, killed: false, stdin: {}, stdout: {}, kill: () => true,
      off: () => {}, on: () => {}, once: () => {},
    });
  }
  get(custodyRef: string) {
    if (!this.refs.has(custodyRef)) {return;}
    return Object.freeze({
      closeInput: async () => {}, custodyRef, stderr: emptyBytes(), stdout: emptyBytes(),
      waitForExit: async () => ({code: 0, signal: null}), write: async () => {},
    });
  }
  evidence(custodyRef: string) {
    if (!this.refs.has(custodyRef)) {return;}
    const started = this.starts > 0;
    return Object.freeze({
      closure: Object.freeze({limitations: Object.freeze([]), profile: "strict-linux-cgroup-v2", status: started ? "closed" : "not-started"}),
      fingerprint: Object.freeze({
        argumentsSha256: "1".repeat(64), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
        environmentKeys: Object.freeze([]), executablePathSha256: "2".repeat(64), executableSha256: "3".repeat(64),
        fingerprintSha256: "4".repeat(64), intentMode: "analysis", planSha256: "5".repeat(64),
        privatePathEnvironmentKeys: Object.freeze([]), privateRootPathSha256: "6".repeat(64),
        providerBindingSha256: "7".repeat(64), spawnMode: "sdk-delegated", workspaceSha256: "8".repeat(64),
      }),
      guardianExit: started ? {code: 0, signal: null, status: "observed"} : {status: "unobserved"},
      identity: started ? {
        binarySha256: "3".repeat(64), childProcessInstanceSha256: "9".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), pgid: 101, pid: 102,
        planSha256: "5".repeat(64), proofRef: "proof:process", status: "proved",
      } : {
        binarySha256: "0".repeat(64), childProcessInstanceSha256: "0".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), planSha256: "0".repeat(64), status: "not-started",
      },
      privateRoot: {identitySha256: "b".repeat(64), status: started ? "deleted" : "active"},
      providerExit: started ? {code: 0, signal: null, status: "observed"} : {status: "not-started"},
      sealed: true, spawn: started ? "acknowledged" : "never-started",
      stderr: {bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : "not-started"},
      stdout: {bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : "not-started"},
    });
  }
  async requestContainment() {this.containments += 1; return {kind: "contained" as const, receiptRef: "receipt:pg"};}
  async release() {this.releases += 1; return {kind: "released" as const};}
}
async function* emptyBytes(): AsyncIterable<Uint8Array> {}

const identities = Object.freeze({
  nextId(kind: string, seed = kind): string {
    if (["attempt", "custody", "effect", "operation"].includes(kind)) {return `${kind}:one`;}
    if (kind === "execution_generation") {return "execution-generation:one";}
    if (kind === "writer_fence") {return "writer-fence:one";}
    return `${kind.replaceAll("_", "-")}:pg:${Buffer.from(seed).toString("hex").slice(0, 48)}`;
  },
});

const mirrorStore = (postgres: PostgresContainedTurnOperationStore, mirror: any, claimGate?: Readonly<{
  reached(): void;
  wait: Promise<void>;
}>): any => new Proxy(postgres, {get(target, property) {
  const durable = Reflect.get(target, property, target);
  if (typeof durable !== "function") {return durable;}
  if (property === "identifyAcceptance" || property === "read" || property === "listDispatchPreparations") {
    return durable.bind(target);
  }
  return async (...arguments_: any[]) => {
    if (property === "claimPreparedDispatch" && claimGate !== undefined) {
      claimGate.reached();
      await claimGate.wait;
    }
    const outcome = await durable.apply(target, arguments_);
    if (property === "claimPreparedDispatch" && outcome.kind === "claimed") {
      const input = arguments_[0];
      await mirror.commit({
        authority: input.authority,
        candidate: outcome.operation,
        expectedRevision: input.expectedOperationRevision,
      });
      return outcome;
    }
    const mirrorMethod = mirror[property];
    if (typeof mirrorMethod === "function") {await mirrorMethod.apply(mirror, arguments_);}
    return outcome;
  };
}});

const forProvider = (fixture: ReturnType<typeof createDependencies>, provider: "claude" | "codex") => {
  if (provider === "codex") {return fixture.dependencies;}
  const providerAccess = fixture.dependencies.providerAccess;
  return Object.freeze({...fixture.dependencies, providerAccess: Object.freeze({...providerAccess,
    resolveForAcceptance: async (...arguments_: Parameters<typeof providerAccess.resolveForAcceptance>) => {
      const outcome = await providerAccess.resolveForAcceptance(...arguments_);
      return outcome.kind === "resolved" ? {...outcome, snapshot: {...outcome.snapshot, provider: "claude" as const}} : outcome;
    },
  })});
};

const createOwner = async (provider: "claude" | "codex", root: string, host: FakeHost) => {
  const workspaceRef = join(root, "workspace");
  const privateRootPath = join(root, "private");
  await mkdir(workspaceRef, {recursive: true, mode: 0o700});
  const workspaceOwner = {async withLaunchAuthority<Result>(_input: unknown, consume: (authority: any) => Promise<Result>) {
    return consume({canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
      identity: {dev: 1n, ino: 2n, mountId: `mount:pg:${provider}`}});
  }};
  if (provider === "codex") {
    const codexHome = join(privateRootPath, "home");
    const temp = join(privateRootPath, "temp");
    await Promise.all([mkdir(codexHome, {recursive: true, mode: 0o700}), mkdir(temp, {recursive: true, mode: 0o700})]);
    return createCodexCurrentKernelOwner({
      hostBootId: "host-boot:pg-codex", hostCustody: host as never, hostInstanceId: "host-instance:pg-codex",
      launchRecords: {resolve: async () => ({boundary: createCodexAppServerPermissionBoundary({codexHome, workspaceRef}),
        executablePath: "/synthetic/codex", privateRootPath, tmpDir: temp})}, workspaceOwner,
    });
  }
  const [configRoot, homeRoot, tempRoot] = ["config", "home", "temp"].map(name => join(privateRootPath, name));
  await Promise.all([configRoot, homeRoot, tempRoot].map(path => mkdir(path, {recursive: true, mode: 0o700})));
  const adapterSnapshot = {adapterRevision: "claude:test", binaryRevision: "claude-binary:test",
    capabilityManifestRevision: "claude-manifest:test", provider: "claude" as const};
  return createClaudeCurrentKernelOwner({
    adapterSnapshot, executablePath: "/synthetic/claude", executableSha256: "a".repeat(64),
    hostBootId: "host-boot:pg-claude", hostCustody: host as never, hostInstanceId: "host-instance:pg-claude",
    launchRecords: {resolve: async () => ({privateProjection: createClaudeAgentSdkPrivateProjection({
      configRoot, homeRoot, projectionRef: "projection:pg-claude", tempRoot, workspaceRef,
    }), privateRootPath})},
    manifest: {effectCardinality: "one_coarse_effect_per_operation", effectClass: "contained_unmediated_effect",
      manifestRevision: adapterSnapshot.capabilityManifestRevision, manifestVersion: 1, provider: "claude",
      providerAttemptCardinality: "at_most_one", requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
      resourceScopeRevision: "contained-workspace-network-credential:1", supportedModes: ["analysis", "workspace-write"],
      unknownCapabilityPolicy: "fail_closed"},
    queryFactory: input => {
      const plan = host.plans.at(-1)!;
      input.options.spawnClaudeCodeProcess({args: [...plan.arguments], command: "/synthetic/claude", cwd: workspaceRef,
        env: {...plan.environment}, signal: new AbortController().signal});
      return {close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {
        yield Promise.reject(new Error("synthetic Claude reconciliation boundary"));
      }};
    }, workspaceOwner,
  });
};

postgresTest("PostgreSQL current owners durably claim once through real Codex and Claude submit paths", async t => {
  assert.ok(databaseUrl);
  const pool = new Pool({connectionString: databaseUrl, max: 12});
  try {
    for (const provider of ["codex", "claude"] as const) {
      await t.test(provider, async () => {
        await pool.query("DROP SCHEMA IF EXISTS agent_execution CASCADE");
        await applyContainedTurnPostgresSchema(pool);
        const root = await mkdtemp(join(tmpdir(), `pg-current-owner-${provider}-`));
        try {
          const preventedHost = new FakeHost();
          const preventedOwner = await createOwner(provider, join(root, "prevented"), preventedHost);
          const preventedFixture = createDependencies({dispatchPrevented: true});
          const preventedStore = new PostgresContainedTurnOperationStore({identities, pool});
          const preventedSelected = forProvider(preventedFixture, provider);
          const prevention = await createContainedTurnFeature({...preventedSelected,
            custody: preventedOwner.custody,
            operationStore: mirrorStore(preventedStore, preventedSelected.operationStore),
            provider: preventedOwner.provider,
          }).submit.execute({commandId: `command:pg-prevented:${provider}`, expectedProvider: provider,
            intent: {mode: "analysis", prompt: "Prevent this durable dispatch."},
            scope: {projectId: "project:pg", tenantId: "tenant:pg"}});
          assert.equal(prevention.status, "observed");
          assert.deepEqual([preventedHost.starts, preventedHost.releases], [0, 1]);
          preventedOwner.dispose();

          await pool.query("DROP SCHEMA agent_execution CASCADE");
          await applyContainedTurnPostgresSchema(pool);
          const host = new FakeHost();
          const owner = await createOwner(provider, join(root, "claimed"), host);
          const fixture = createDependencies();
          const selected = forProvider(fixture, provider);
          const durable = new PostgresContainedTurnOperationStore({identities, pool});
          let releaseClaim!: () => void;
          let reportClaim!: () => void;
          const wait = new Promise<void>(resolve => {releaseClaim = resolve;});
          const reached = new Promise<void>(resolve => {reportClaim = resolve;});
          const store = mirrorStore(durable, selected.operationStore, {reached: reportClaim, wait});
          const dependencies = {...selected, custody: owner.custody, operationStore: store, provider: owner.provider};
          const request = {commandId: `command:pg-claimed:${provider}`, expectedProvider: provider,
            intent: {mode: "analysis" as const, prompt: "Exercise the durable claim."},
            scope: {projectId: "project:pg", tenantId: "tenant:pg"}};
          const submission = createContainedTurnFeature(dependencies).submit.execute(request);
          await reached;
          assert.equal(host.starts, 0);
          const beforeClaim = await pool.query("SELECT state FROM agent_execution.contained_turn_dispatch_preparation_v1");
          assert.equal(beforeClaim.rowCount, 1);
          assert.equal(beforeClaim.rows[0]?.state.payload.kind, "active");
          assert.equal((await pool.query("SELECT 1 FROM agent_execution.contained_turn_operation_v1")).rowCount, 1);
          releaseClaim();
          const result = await submission;
          assert.equal(host.starts, 1);
          assert.equal(result.status, "observed");
          assert.ok(result.status === "observed" && ["reconcile_required", "succeeded"].includes(result.turn.status));
          assert.ok(host.containments > 0);

          const reconstructed = new PostgresContainedTurnOperationStore({identities, pool});
          const storedRow = await pool.query<{operation_id: string}>(
            "SELECT operation_id FROM agent_execution.contained_turn_operation_v1 WHERE command_id=$1",
            [request.commandId],
          );
          const operationId = storedRow.rows[0]?.operation_id;
          assert.ok(operationId);
          const persisted = await reconstructed.read({operationId: operationId as never, scope: request.scope});
          assert.equal(persisted?.dispatch.kind, "claimed");
          const replayFixture = createDependencies();
          const replaySelected = forProvider(replayFixture, provider);
          const replay = await createContainedTurnFeature({...replaySelected, custody: owner.custody,
            operationStore: mirrorStore(reconstructed, replaySelected.operationStore), provider: owner.provider,
          }).submit.execute(request);
          assert.equal(replay.status, "observed");
          assert.equal(host.starts, 1);
          assert.ok(host.releases > 0 || replay.status === "observed" && replay.turn.status === "reconcile_required");
          owner.dispose();
        } finally {await rm(root, {recursive: true, force: true});}
      });
    }
  } finally {
    await pool.end();
  }
});
