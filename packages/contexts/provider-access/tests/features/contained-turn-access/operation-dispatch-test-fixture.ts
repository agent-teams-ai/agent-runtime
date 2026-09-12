import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDispatchConsumptionRequestDigests } from "../../../dist/composition.js";
import { createOperationDispatchConsumption } from "../../../dist/features/contained-turn-access/composition/operation-dispatch-consumption.js";
import { createContainedTurnProviderAccessFeature } from "../../../dist/features/contained-turn-access/composition/feature-module-factory.js";
import { createMaterializationBindingRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/postgres/materialization-binding-repository.js";
import type { PaDispatchIssuanceSelection, PaOperationStore, PaOperationRecordKind } from "../../../dist/features/contained-turn-access/adapters/outbound/dispatch-operation-contracts.js";
import type { ContainedTurnProviderAccessBinding } from "../../../dist/index.js";

// Independent mapping fixture: no AE import or request-derived policy issuance.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (value && typeof value === "object") {return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));}
  return value;
};
export const fixtureHash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
export const issuanceFixture = (now = 100): PaDispatchIssuanceSelection => ({
  issuanceRef: "issuance:operator:profile-7",
  binding: {accessRef: "access:profile-7", availability: "available", revocation: "active", bindingRevision: 7,
    credentialBindingDigest: fixtureHash({material: "original-credential-C-7"}), credentialBindingRef: "credential:profile-7", credentialGeneration: 3,
    projectId: "project:pa-v2", tenantId: "tenant:pa-v2", provider: "codex", providerAccountRef: "account:profile-7", providerRouteRef: "route:profile-7",
    scopeDigest: fixtureHash({projectId: "project:pa-v2", tenantId: "tenant:pa-v2", version: 1})},
  materializationHeadVersion: 1, validFromControlTime: now, claimBeforeControlTime: now + 120_000, expiresAtControlTime: now + 180_000,
});
export const acceptedFixture = async (binding: ContainedTurnProviderAccessBinding, operationId: string, grantRequestId = `grant:${operationId}`) => {
  const scope = {tenantId: binding.tenantId, projectId: binding.projectId,
    scopeDigest: fixtureHash({projectId: binding.projectId, tenantId: binding.tenantId, version: 1})};
  const credentialBindingDigest = fixtureHash({ownerDigest: binding.credentialBindingDigest});
  const providerBindingDigest = fixtureHash({...binding, credentialBindingDigest, ownerAuthorityDigest: binding.credentialBindingDigest, version: 1});
  // Test-owned acknowledged projection, not an assertion about AE's database.
  const acceptedAuthorityDigest = fixtureHash({operationId, providerBindingDigest, securityDecision: "fixture:independent-decision"});
  const unsigned = {binding: {acceptedAuthorityDigest, accessRef: binding.accessRef,
    authorityHeadDigest: binding.credentialBindingDigest, bindingDigest: providerBindingDigest, bindingRevision: binding.revision,
    credentialBindingDigest, credentialBindingRef: binding.credentialBindingRef, credentialGeneration: binding.credentialGeneration,
    providerAccountRef: binding.providerAccountRef, providerRouteRef: binding.providerRouteRef},
  scope, provider: binding.provider, operationId, grantRequestId, purpose: "contained-turn.provider-dispatch/v1" as const};
  const request = {...unsigned, ...await createDispatchConsumptionRequestDigests(unsigned)};
  return {request, prepared: {operationId, scope, provider: binding.provider, acceptedAuthorityDigest,
    acceptanceEvidenceRef: `acceptance:${operationId}`, acceptedBinding: binding, providerBindingDigest,
    grantRequestId, claimBindingDigest: request.claimBindingDigest, requestDigest: request.requestDigest}};
};

/** Transactional retained in-memory storage, not SQL emulation or PG evidence. */
export const operationHarness = () => {
  const selection = issuanceFixture();
  const state = {binding: structuredClone(selection.binding), version: 1, now: 100, failBeforeCommit: false, unavailable: false,
    loseCommit: undefined as PaOperationRecordKind | undefined,
    beforeCommit: undefined as ((kinds: readonly PaOperationRecordKind[]) => Promise<void>) | undefined};
  let records = new Map<string, unknown>();
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = tail.then(work); tail = pending.catch(() => {}); return pending;
  };
  const store: PaOperationStore = {
    transact: (owner, work) => serialize(async () => {
      if (state.unavailable) {throw new Error("Synthetic owner read unavailable");}
      const draft = new Map(records); const kinds: PaOperationRecordKind[] = [];
      let open = true;
      const keyFor = (kind: PaOperationRecordKind, key: string) => JSON.stringify([canonical(owner), kind, key]);
      const check = () => {assert.equal(open, true);};
      try {
        const result = await work({checkOpen: check, controlTime: state.now, materialization: {binding: structuredClone(state.binding), version: state.version},
          async read(kind, key) {check(); return structuredClone(draft.get(keyFor(kind, key)));},
          async insert(kind, key, value) {check(); const id = keyFor(kind, key); assert.equal(draft.has(id), false, "immutable per-owner kind/key");
            draft.set(id, structuredClone(value)); kinds.push(kind);},
        });
        await state.beforeCommit?.(kinds);
        if (state.failBeforeCommit) {throw new Error("Synthetic rollback");}
        records = draft;
        if (state.loseCommit && kinds.includes(state.loseCommit)) {state.loseCommit = undefined; throw new Error("Synthetic lost acknowledgement");}
        return result;
      } finally {open = false;}
    }),
  };
  const current = createContainedTurnProviderAccessFeature({bindingRepository: createMaterializationBindingRepository(
    async () => structuredClone(state.binding), {provider: selection.binding.provider, tenantId: selection.binding.tenantId,
      projectId: selection.binding.projectId, scopeDigest: selection.binding.scopeDigest})});
  const accept = async (operationId: string, grantRequestId?: string) => {
    const result = await current.resolve.execute({provider: selection.binding.provider,
      scope: {tenantId: selection.binding.tenantId, projectId: selection.binding.projectId}});
    assert.equal(result.kind, "resolved"); if (result.kind !== "resolved") {throw new Error("Expected current PA resolution");}
    assert.equal(result.evidence.bindingAuthorityDigest, selection.binding.credentialBindingDigest);
    return acceptedFixture(result.binding, operationId, grantRequestId);
  };
  return {selection, state, store, current, accept, rebuild: (next = selection) => createOperationDispatchConsumption(store, next),
    records: (kind: PaOperationRecordKind) => [...records].filter(([key]) => JSON.parse(key)[1] === kind).map(([, value]) => structuredClone(value)),
    changeBinding: (binding: typeof state.binding) => serialize(async () => {state.binding = structuredClone(binding); state.version++;}),
  };
};
