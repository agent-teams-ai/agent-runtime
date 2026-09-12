import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { submitContainedTurn } from "../../../dist/features/contained-agent-turn/application/contained-turn-submission.js";
import { claimContainedTurnWithConsumedGrants } from "../../../dist/features/contained-agent-turn/application/contained-turn-grant-claim.js";
import { containedTurnAcceptanceIntentDigestV1, containedTurnAcceptanceConstraintsDigestV1 } from "../../../dist/features/contained-agent-turn/application/contained-turn-acceptance-digests.js";
import { createContainedTurnAcceptedAuthorityHandoff } from "../../../dist/features/contained-agent-turn/application/contained-turn-accepted-authority.js";
import { createDependencies } from "./support/contained-agent-turn-fixture.ts";

const input = {
  commandId: "command:handoff", expectedProvider: "codex" as const,
  intent: { mode: "analysis" as const, prompt: "Retained exact intent π" },
  scope: { projectId: "project:one", tenantId: "tenant:one" },
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;

test("parallel acceptance forwards one allocation; acknowledgement gates both detached owner projections", async () => {
  const { dependencies } = createDependencies();
  const accessStarted = Promise.withResolvers<void>();
  const securityStarted = Promise.withResolvers<void>();
  const acceptanceStarted = Promise.withResolvers<void>();
  const acknowledge = Promise.withResolvers<void>();
  let allocated: string | undefined;
  const consumed: unknown[] = [];
  const configured = {
    ...dependencies,
    operationStore: {
      ...dependencies.operationStore,
      identifyAcceptance: async (...args: Parameters<typeof dependencies.operationStore.identifyAcceptance>) => {
        const result = await dependencies.operationStore.identifyAcceptance(...args);
        if (result.kind === "available") {allocated = result.operationId;}
        return result;
      },
      accept: async (...args: Parameters<typeof dependencies.operationStore.accept>) => {
        acceptanceStarted.resolve();
        await acknowledge.promise;
        return dependencies.operationStore.accept(...args);
      },
    },
    providerAccess: {
      ...dependencies.providerAccess,
      resolveForAcceptance: async (request: Parameters<typeof dependencies.providerAccess.resolveForAcceptance>[0]) => {
        assert.equal(request.operationId, allocated);
        accessStarted.resolve();
        await securityStarted.promise;
        return dependencies.providerAccess.resolveForAcceptance(request);
      },
      consumeForDispatch: async (request: Parameters<typeof dependencies.providerAccess.consumeForDispatch>[0]) => {
        consumed.push(request.accepted);
        return dependencies.providerAccess.consumeForDispatch(request);
      },
    },
    security: {
      ...dependencies.security,
      authorizeForAcceptance: async (request: Parameters<typeof dependencies.security.authorizeForAcceptance>[0]) => {
        assert.equal(request.operationId, allocated);
        assert.equal(request.constraintsDigest, digest({
          adapterSnapshot: dependencies.provider.adapterSnapshot,
          capabilityManifest: dependencies.provider.manifest, intentMode: input.intent.mode,
        }));
        securityStarted.resolve();
        await accessStarted.promise;
        return dependencies.security.authorizeForAcceptance(request);
      },
      consumeForDispatch: async (request: Parameters<typeof dependencies.security.consumeForDispatch>[0]) => {
        consumed.push(request.accepted);
        assert.equal(request.accepted.constraintsDigest, request.subject.runtimeSecurityExpectation.constraintsDigest);
        assert.equal(request.accepted.intentDigest, digest({
          purpose: "contained_turn_acceptance_intent_v1", intent: input.intent, version: 1,
        }));
        assert.deepEqual(request.accepted.intent, input.intent);
        assert.notEqual(request.accepted.intent, input.intent);
        assert.ok(Object.isFrozen(request.accepted.acceptedAuthorityVector.providerAccessSnapshot));
        return dependencies.security.consumeForDispatch(request);
      },
    },
  };
  const submission = submitContainedTurn(configured, input);
  await acceptanceStarted.promise;
  assert.deepEqual(consumed, []);
  acknowledge.resolve();
  assert.equal((await submission).status, "observed");
  assert.equal(consumed.length, 2);
  assert.deepEqual(consumed[0], consumed[1]);
});

test("uncertain acceptance never produces an accepted projection", async () => {
  const fixture = createDependencies({ potentialAcceptance: true });
  let consumed = 0;
  const result = await submitContainedTurn({
    ...fixture.dependencies,
    providerAccess: { ...fixture.dependencies.providerAccess, consumeForDispatch: async () => { consumed++; throw new Error("must not consume"); } },
    security: { ...fixture.dependencies.security, consumeForDispatch: async () => { consumed++; throw new Error("must not consume"); } },
  }, input);
  assert.equal(result.status, "potential_acceptance");
  assert.equal(consumed, 0);
  assert.equal(fixture.createdWorkspaces.length, 0);
});

test("proof, vector, scope, provider and both request substitutions fail before any owner consumes", async () => {
  const fixture = createDependencies();
  const { dependencies } = fixture;
  let captured: Parameters<typeof dependencies.providerAccess.consumeForDispatch>[0] | undefined;
  let retained: ReturnType<typeof fixture.current>;
  await submitContainedTurn({
    ...dependencies,
    providerAccess: {
      ...dependencies.providerAccess,
      consumeForDispatch: async request => {
        captured = request;
        retained = fixture.current();
        return dependencies.providerAccess.consumeForDispatch(request);
      },
    },
  }, input);
  assert.ok(captured);
  assert.ok(retained);
  const subject = captured.subject;
  const reconstructed = JSON.parse(JSON.stringify(retained));
  assert.deepEqual(createContainedTurnAcceptedAuthorityHandoff(reconstructed, input.scope, subject), captured.accepted);
  assert.equal(containedTurnAcceptanceIntentDigestV1(retained.intent), captured.accepted.intentDigest);
  assert.equal(containedTurnAcceptanceConstraintsDigestV1(retained), digest(captured.accepted.constraints));
  let consumes = 0;
  const forbidden = {
    ...dependencies,
    providerAccess: { ...dependencies.providerAccess, consumeForDispatch: async () => { consumes++; throw new Error("unexpected consume"); } },
    security: { ...dependencies.security, consumeForDispatch: async () => { consumes++; throw new Error("unexpected consume"); } },
  };
  const badDigest = `sha256:${"f".repeat(64)}`;
  for (const corrupt of [
    (operation: typeof reconstructed) => {operation.scope.projectId = "project:foreign";},
    (operation: typeof reconstructed) => {operation.acceptedAuthorityVector.securityAuthorityRevision = "security:foreign";},
    (operation: typeof reconstructed) => {operation.proofs[0].binding.operationId = "operation:foreign";},
    (operation: typeof reconstructed) => {operation.intent.prompt = "substituted";},
  ]) {
    const operation = JSON.parse(JSON.stringify(retained));
    corrupt(operation);
    assert.equal((await claimContainedTurnWithConsumedGrants(forbidden, operation, input.scope, subject, undefined as never)).kind, "unavailable");
  }
  for (const changed of [
    { ...subject, scope: { ...subject.scope, projectId: "project:foreign" } },
    { ...subject, provider: "claude" as const },
    { ...subject, attemptId: "invalid-attempt" },
    ...(["providerAccessRequest", "runtimeSecurityRequest"] as const).flatMap(owner =>
      (["requestDigest", "claimBindingDigest", "grantRequestId"] as const).map(field => ({
        ...subject, [owner]: { ...subject[owner], [field]: badDigest },
      }))),
    { ...subject, providerAccessRequest: { ...subject.providerAccessRequest, requestDigest: badDigest } },
    { ...subject, runtimeSecurityRequest: { ...subject.runtimeSecurityRequest, requestDigest: badDigest } },
    { ...subject, providerAccessExpectation: { ...subject.providerAccessExpectation, acceptedAuthorityDigest: badDigest } },
    { ...subject, runtimeSecurityExpectation: { ...subject.runtimeSecurityExpectation, constraintsDigest: badDigest } },
  ]) {
    assert.equal((await claimContainedTurnWithConsumedGrants(forbidden, retained, input.scope, changed as typeof subject, undefined as never)).kind, "unavailable");
  }
  assert.equal(consumes, 0);
});

for (const field of ["hostBootId", "hostInstanceId"] as const) {
  test(`malformed custody ${field} retires the submission reservation without consuming or retrying`, async () => {
    const fixture = createDependencies();
    const { dependencies } = fixture;
    let consumes = 0;
    let retirements = 0;
    let preparations = 0;
    let cleanup: Awaited<ReturnType<typeof dependencies.operationStore.recordDispatchPreparationCleanup>> | undefined;
    const configured = {
      ...dependencies,
      operationStore: {
        ...dependencies.operationStore,
        prepareDispatch: async (...args: Parameters<typeof dependencies.operationStore.prepareDispatch>) => {
          preparations++;
          return dependencies.operationStore.prepareDispatch(...args);
        },
        retireDispatchPreparation: async (...args: Parameters<typeof dependencies.operationStore.retireDispatchPreparation>) => {
          retirements++;
          const result = await dependencies.operationStore.retireDispatchPreparation(...args);
          assert.equal(result.kind, "retired");
          return result;
        },
        recordDispatchPreparationCleanup: async (...args: Parameters<typeof dependencies.operationStore.recordDispatchPreparationCleanup>) => {
          cleanup = await dependencies.operationStore.recordDispatchPreparationCleanup(...args);
          return cleanup;
        },
      },
      custody: {
        ...dependencies.custody,
        open: async (...args: Parameters<typeof dependencies.custody.open>) => ({
          ...await dependencies.custody.open(...args), [field]: "invalid-boot",
        }),
      },
      providerAccess: { ...dependencies.providerAccess, consumeForDispatch: async () => { consumes++; throw new Error("must not consume"); } },
      security: { ...dependencies.security, consumeForDispatch: async () => { consumes++; throw new Error("must not consume"); } },
    };
    assert.equal((await submitContainedTurn(configured, input)).status, "observed");
    assert.equal(cleanup?.kind, "cleanup_pending");
    assert.ok(cleanup?.kind === "cleanup_pending");
    assert.equal(cleanup.custodyReleased, true);
    // Preserve unresolved owner obligations; a local validation failure is not
    // an owner settlement or a durable no-consumption proof.
    assert.equal(cleanup.providerAccessNotConsumed, false);
    assert.equal(cleanup.runtimeSecurityNotConsumed, false);
    assert.equal(fixture.current()?.dispatch.kind, "unclaimed");
    assert.equal(fixture.current()?.reconciliation.kind, "required");
    assert.equal(consumes, 0);
    assert.equal(retirements, 1);
    assert.equal(preparations, 1);
    assert.equal(fixture.openedCustodies.length, 1);
    assert.equal(fixture.custodyReleases.length, 1);
    assert.equal(fixture.custodyReleases[0]?.custodyId, cleanup?.custodyId);
    assert.equal(fixture.custodyReleases[0]?.attemptId, cleanup?.attemptId);
    assert.equal(fixture.providerCalls.value, 0);
    assert.equal(fixture.custodyStartInputs.length, 0);
  });
}
