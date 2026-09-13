import assert from "node:assert/strict";
import {createLinuxCodexDeploymentAuthority} from "../../../dist/composition/linux-codex-deployment-authority.js";
import type {ContainedTurnFeatureDependencies} from "@agent-teams/agent-execution/composition";

type Ports = Pick<ContainedTurnFeatureDependencies, "providerAccess" | "security">;
type Readers = Parameters<typeof createLinuxCodexDeploymentAuthority>[0];
type Input = Parameters<Ports["security"]["consumeForDispatch"]>[0];
type Kernel = Parameters<ReturnType<typeof createLinuxCodexDeploymentAuthority>["take"]>[0];

// All acknowledgement and head reads go through the actual PostgreSQL owners.
// Negative readers deliberately select absent/other operation keys, never mint heads.
export const postgresDeploymentSelection = (ports: Ports, readers: Readers,
  otherKey: Parameters<Readers["runtimeSecurity"]["readAuthority"]>[0]) => {
  const create = (runtimeSecurity = readers.runtimeSecurity) =>
    createLinuxCodexDeploymentAuthority({...readers, runtimeSecurity}, "c57e74694230be246f25d88360fc8409ac5d872b");
  const authority = create();
  const missingReads: Awaited<ReturnType<Readers["runtimeSecurity"]["readAuthority"]>>[] = [];
  const mismatchedReads: typeof missingReads = [];
  const missing = create({async readAuthority(key) {
    const head = await readers.runtimeSecurity.readAuthority({...key, operationId: "operation:absent-pg-deployment"});
    missingReads.push(head);
    return head;
  }});
  const mismatch = create({async readAuthority() {
    const head = await readers.runtimeSecurity.readAuthority(otherKey);
    mismatchedReads.push(head);
    return head;
  }});
  const selections = [authority, missing, mismatch];
  const bound = selections.map(selection => selection.bind(ports));
  let acknowledged: Input | undefined;
  let checks = 0;
  return {
    get checks() {return checks;},
    bindStore(store: ContainedTurnFeatureDependencies["operationStore"]) {
      return selections.reduce((boundStore, selection) => selection.bindStore(boundStore), store);
    },
    ports: {
      providerAccess: {...ports.providerAccess, async consumeForDispatch(input: Parameters<Ports["providerAccess"]["consumeForDispatch"]>[0]) {
        const outcomes = [];
        for (const binding of bound) {outcomes.push(await binding.providerAccess.consumeForDispatch(input));}
        for (const outcome of outcomes) {assert.deepEqual(outcome, outcomes[0]);}
        return outcomes[0]!;
      }},
      security: {...ports.security, async consumeForDispatch(input: Input) {
        // Before this RS acknowledgement, no complete pair is selectable.
        assert.throws(() => authority.take({...input.subject,
          authorityVectorDigest: input.accepted.acceptedAuthorityVectorDigest,
          adapterSnapshot: input.accepted.acceptedAuthorityVector.adapterSnapshot,
          providerAccessSnapshot: input.accepted.acceptedAuthorityVector.providerAccessSnapshot} as Kernel), /acknowledged/u);
        const outcomes = [];
        for (const binding of bound) {outcomes.push(await binding.security.consumeForDispatch(input));}
        for (const outcome of outcomes) {assert.deepEqual(outcome, outcomes[0]);}
        assert.equal(outcomes[0]!.kind, "consumed");
        acknowledged = input;
        return outcomes[0]!;
      }},
    } satisfies Ports,
    async checkClaim(operation: Awaited<ReturnType<ContainedTurnFeatureDependencies["operationStore"]["read"]>>) {
      assert.ok(acknowledged);
      assert.ok(operation && operation.dispatch.kind === "claimed");
      const {subject, accepted} = acknowledged;
      assert.equal(operation.operationId, subject.operationId);
      assert.equal(operation.dispatch.attemptId, subject.attemptId);
      assert.equal(operation.custodyId, subject.custodyId);
      assert.equal(operation.effectId, subject.effectId);
      assert.equal(operation.dispatch.preparationToken, subject.preparationToken);
      assert.equal(operation.dispatch.operationCutoffRevision, subject.operationCutoffRevision);
      assert.equal(operation.dispatch.executionGenerationId, subject.executionGenerationId);
      assert.equal(operation.hostBootId, subject.hostBootId);
      assert.equal(operation.hostInstanceId, subject.hostInstanceId);
      assert.equal(operation.workspaceId, subject.workspaceId);
      assert.equal(operation.acceptedAuthorityVectorDigest, accepted.acceptedAuthorityVectorDigest);
      const kernel = {...subject, authorityVectorDigest: operation.acceptedAuthorityVectorDigest,
        adapterSnapshot: operation.adapterSnapshot, providerAccessSnapshot: operation.providerAccessSnapshot} as Kernel;
      for (const key of ["operationId", "attemptId", "custodyId", "effectId", "workspaceId", "preparationToken", "authorityVectorDigest"] as const) {
        assert.throws(() => authority.take({...kernel, [key]: `${kernel[key]}:mismatch`}), /acknowledged/u);
      }
      assert.throws(() => authority.take({...kernel, operationCutoffRevision: (kernel.operationCutoffRevision + 1) as Kernel["operationCutoffRevision"]}), /acknowledged/u);
      assert.throws(() => authority.take({...kernel, adapterSnapshot: {...kernel.adapterSnapshot, adapterRevision: "mismatch"}}), /acknowledged/u);
      assert.throws(() => authority.take({...kernel, providerAccessSnapshot: {...kernel.providerAccessSnapshot, revision: -1}}), /acknowledged/u);
      // Assert outside capture(), whose intentional fail-closed catch could
      // otherwise swallow a failed assertion or an unrelated reader failure.
      assert.equal(missingReads.length, 2);
      for (const head of missingReads) {
        assert.equal(head.headVersion, "0");
        assert.equal(head.authority, undefined);
      }
      assert.equal(mismatchedReads.length, 2);
      for (const head of mismatchedReads) {
        assert.equal(head.headVersion, "1");
        assert.equal(head.authority!.operationId, otherKey.operationId);
        assert.notEqual(head.authority!.operationId, operation.operationId);
      }
      assert.throws(() => missing.take(kernel), /acknowledged/u);
      assert.throws(() => mismatch.take(kernel), /acknowledged/u);
      const selected = authority.take(kernel);
      assert.equal(selected.acceptedDispatch.headVersion, "1");
      assert.equal(selected.acceptedDispatch.authority!.operationId, operation.operationId);
      assert.equal(selected.acceptedDispatch.authority!.claimBindingDigest, subject.runtimeSecurityRequest.claimBindingDigest);
      assert.equal(selected.binding.authorityVectorDigest, operation.acceptedAuthorityVectorDigest);
      assert.equal(selected.upstream.providerAccessSnapshot.ownerAuthorityDigest, selected.current.binding.credentialBindingDigest);
      assert.throws(() => authority.take(kernel), /acknowledged/u);
      checks++;
      return {kernel, acknowledged, create};
    },
  };
};
