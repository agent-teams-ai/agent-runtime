import assert from "node:assert/strict";
import test from "node:test";
import {containedTurnCommandFingerprint} from "../../../dist/features/contained-agent-turn/domain/contained-turn-authority.js";
import {ORDINARY_PROFILE, type OrdinaryOperation, type OrdinaryPreparation} from "../../../dist/features/contained-agent-turn/domain/ordinary-model.js";
import {ordinaryPreparationDigest} from "../../../dist/features/contained-agent-turn/domain/ordinary-validation.js";
import {createOrdinaryTurnFeature} from "../../../dist/features/contained-agent-turn/composition/ordinary-feature-factory.js";
import {createNodeOrdinaryProcess} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-process/node-ordinary-process.js";
import {createOrdinaryCodexAdapter} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-provider.js";
import type {OrdinaryTurnDependencies} from "../../../dist/features/contained-agent-turn/application/ordinary-ports.js";

const hash = "a".repeat(64);
const input = {commandId: "test-command", expectedProvider: "codex", intent: {mode: "workspace-write", prompt: "Read TASK.md"}, scope: {projectId: "ordinary-test", tenantId: "test"}} as const;
const binding = {operationId: "ordinary:test", attemptId: "attempt:test", executionProfile: ORDINARY_PROFILE.executionProfile, capabilityManifestRevision: ORDINARY_PROFILE.capabilityManifestRevision};
const initial = (): OrdinaryOperation => ({...binding, ...ORDINARY_PROFILE, schemaVersion: 3, effectId: "effect:test", commandId: input.commandId,
  fingerprint: containedTurnCommandFingerprint({scope: input.scope, intent: input.intent, provider: input.expectedProvider}), scope: input.scope, input,
  preparation: null, revision: 0, status: "accepted", cancellationRequested: false, output: [], receipts: []} as OrdinaryOperation);
const authority = (owner: "provider_access" | "runtime_security") => ({...binding, owner, grantId: owner, ownerReceiptId: `receipt:${owner}`, consumptionDigest: hash,
  consumptionRevision: 1, authorityDigest: hash, expiresAt: Date.now() + 55_000, scope: input.scope, provider: "codex" as const});

/** Real process owner and real Codex provider inside the engine, with only spawn and kill mocked. */
test("the real process owner and the real Codex provider agree on the sealed launch facts inside the engine", async t => {
  const childProcess = await import("node:child_process");
  const {syncBuiltinESMExports} = await import("node:module");
  const {PassThrough} = await import("node:stream");
  const child = new childProcess.ChildProcess();
  child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {...platform, value: "darwin"});
  t.mock.method(process, "getuid", () => 1000);
  t.mock.method(childProcess.default, "spawn", () => {
    setImmediate(() => {child.stdout.emit("end"); child.stderr.emit("end"); child.emit("exit", 0); child.emit("close", 0);});
    return child;
  });
  t.mock.method(process, "kill", () => {throw Object.assign(new Error("TEST group absent"), {code: "ESRCH"});});
  syncBuiltinESMExports();
  t.after(() => {Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports();});

  let operation: OrdinaryOperation | undefined;
  let prepared: OrdinaryPreparation | undefined;
  const stages: string[] = [];
  const codex = createOrdinaryCodexAdapter({executable: "/TEST/never-executed", record: event => {stages.push(event.stage ?? event.kind);}});
  const processOwner = createNodeOrdinaryProcess({prepareLaunch: async request => ({executable: "/TEST/never-executed", arguments: [], cwd: request.workspace.cwd, environment: {SYNTHETIC: "x"}})});
  const receipt = <K extends string>(value: K, extra: Record<string, unknown>) => ({...binding, kind: value, ...extra});
  const claimReceipt = () => receipt("dispatch_claim", {claimId: "claim:test", committedRevision: 2, reservationId: prepared!.reservationId, preparationDigest: ordinaryPreparationDigest(prepared!)});
  const store = {
    accept: async () => {operation = initial(); return {kind: "accepted", operation};},
    read: async () => operation,
    prepare: async (current: OrdinaryOperation, value: OrdinaryPreparation) => {prepared = value; operation = {...current, preparation: value, revision: current.revision + 1}; return operation;},
    claim: async (current: OrdinaryOperation) => {const claim = claimReceipt(); operation = {...current, revision: 2, status: "running", receipts: [claim]} as OrdinaryOperation; return {kind: "claimed", operation, receipt: claim};},
    cancel: async () => operation,
    append: async (current: OrdinaryOperation) => current,
    finish: async (_current: OrdinaryOperation, receipts: unknown) => {operation = {...operation, receipts, status: "failed"} as OrdinaryOperation; return operation;},
    reconcile: async (_current: OrdinaryOperation, receipts: unknown) => {operation = {...operation, receipts, status: "reconcile_required"} as OrdinaryOperation; return operation;},
  };
  const dependencies = {
    operationStore: store,
    providerAccess: {resolveAndConsume: async () => {
      const snapshot = authority("provider_access");
      return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot,
        materialize: async () => ({brokerEndpoint: "http://127.0.0.1:1234", materializationId: "material:test", generation: 1, environment: {SYNTHETIC: "x"}}),
        retire: async () => receipt("credential_retired", {materializationId: "material:test", generation: 1, retiredAt: new Date().toISOString()}),
        settle: async (disposition: string) => receipt("provider_grant_settled", {grantId: snapshot.grantId, ownerReceiptId: snapshot.ownerReceiptId, settlementReceiptId: "settled:provider", disposition})};
    }},
    security: {resolveAndConsume: async () => {
      const snapshot = authority("runtime_security");
      return {grantId: snapshot.grantId, expiresAt: snapshot.expiresAt, authority: snapshot, admitOutput: async () => true, admitArtifact: async () => true,
        settle: async (disposition: string) => receipt("security_grant_settled", {grantId: snapshot.grantId, ownerReceiptId: snapshot.ownerReceiptId, settlementReceiptId: "settled:security", disposition})};
    }},
    workspace: {prepare: async () => ({workspaceId: "workspace:test", cwd: "/test", homeDirectory: "/test/home"}), snapshot: async () => {throw new Error("not reached");}, close: async () => {}},
    artifacts: {publish: async () => {throw new Error("not reached");}},
    process: processOwner,
    provider: codex.provider,
  } as unknown as OrdinaryTurnDependencies;
  const feature = createOrdinaryTurnFeature(dependencies);
  await feature.submit.execute(input).catch(() => {});
  await feature.dispose().catch(() => {});
  assert.ok(stages.includes("initialize_request"), `launch facts were refused in the real composition: ${JSON.stringify(stages)}`);
  assert.notEqual(stages.at(-1), "binding");
});
