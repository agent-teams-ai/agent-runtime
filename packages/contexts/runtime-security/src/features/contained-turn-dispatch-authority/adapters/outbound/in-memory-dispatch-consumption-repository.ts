import type { PersistedConsumption,DispatchConsumptionRepository } from "../../application/ports/outbound/dispatch-consumption-repository.js";
import { isNodeDispatchProxy } from "../node-dispatch-proxy.js";
import {
  snapshotDispatchAuthorityHead,
} from "../../domain/dispatch-authority-head.js";
import type { DispatchAuthorityHead, DispatchAuthorityScope } from "../../domain/dispatch-authority-head.js";
import { isBoundedDispatchIdentifier } from "../../application/dispatch-consumption-models.js";
import { snapshotExactDispatchRecord } from "../../domain/dispatch-exact-record.js";
import {
  consumeInMemory,
  observeInMemory,
  settleInMemory,
} from "./in-memory-dispatch-consumption-operations.js";
import type { InMemoryDispatchConsumptionState } from "./in-memory-dispatch-consumption-state.js";
import { operationKey } from "./in-memory-dispatch-consumption-state.js";

const persistedAuthority = (head: DispatchAuthorityHead): DispatchAuthorityHead => {
  if (isNodeDispatchProxy(head)) {throw new TypeError("invalid dispatch authority head");}
  const scopeDescriptor = Object.getOwnPropertyDescriptor(head, "scope");
  if (scopeDescriptor !== undefined && "value" in scopeDescriptor &&
      isNodeDispatchProxy(scopeDescriptor.value)) {throw new TypeError("invalid dispatch authority head");}
  const snapshot = snapshotDispatchAuthorityHead(head);
  if (snapshot === undefined) {throw new TypeError("invalid dispatch authority head");}
  return snapshot;
};

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: () => { release?.(); } };
};

export interface InMemoryDispatchConsumptionRepository
  extends DispatchConsumptionRepository {
  replaceAuthority(head: DispatchAuthorityHead): Promise<void>;
  revokeAuthority(scope: DispatchAuthorityScope, providerId: string,
    authorityGeneration: string, operationId: string): Promise<void>;
  setAvailable(available: boolean): void;
  inspectConsumption(
    scope: DispatchAuthorityScope,
    providerId: string,
    authorityGeneration: string,
    operationId: string,
  ): Promise<PersistedConsumption | undefined>;
}

/** Deterministic single-owner adapter. It never performs I/O or starts work. */
export const createInMemoryDispatchConsumptionRepository = (
  initialAuthorities: readonly DispatchAuthorityHead[] = [],
): InMemoryDispatchConsumptionRepository => {
  let available = true;
  let tail: Promise<void> = Promise.resolve();
  const state: InMemoryDispatchConsumptionState = {
    authorities: new Map(),
    consumeRequests: new Map(),
    consumptionsByOperation: new Map(),
    consumptionsByDigest: new Map(),
    settlementRequests: new Map(),
    async exclusive<Value>(work: () => Value): Promise<Value> {
      const predecessor = tail;
      const successor = deferred();
      tail = successor.promise;
      await predecessor;
      try {
        if (!available) {throw new Error("dispatch consumption owner unavailable");}
        return work();
      } finally {
        successor.resolve();
      }
    },
  };
  for (const authority of initialAuthorities) {
    const snapshot = persistedAuthority(authority);
    state.authorities.set(
      operationKey(snapshot.scope, snapshot.providerId, snapshot.authorityGeneration,
        snapshot.operationId),
      snapshot,
    );
  }
  return {
    consumeAtomically: (key, decide) => consumeInMemory(state, key, decide),
    observe: key => observeInMemory(state, key),
    settleAtomically: (key, decide) => settleInMemory(state, key, decide),
    async replaceAuthority(head) {
      const snapshot = persistedAuthority(head);
      await state.exclusive(() => {
        state.authorities.set(
          operationKey(snapshot.scope, snapshot.providerId, snapshot.authorityGeneration,
            snapshot.operationId),
          snapshot,
        );
      });
    },
    async revokeAuthority(scope, providerId, authorityGeneration, operationId) {
      if (isNodeDispatchProxy(scope)) {throw new TypeError("invalid authority selector");}
      const scopeFields = snapshotExactDispatchRecord(scope, ["tenantId", "projectId", "scopeDigest"]);
      if (scopeFields === undefined || ![scopeFields.tenantId, scopeFields.projectId,
        scopeFields.scopeDigest, providerId, authorityGeneration, operationId]
        .every(isBoundedDispatchIdentifier)) {throw new TypeError("invalid authority selector");}
      const acceptedScope = Object.freeze({ tenantId: scopeFields.tenantId as string,
        projectId: scopeFields.projectId as string, scopeDigest: scopeFields.scopeDigest as string });
      const acceptedProviderId = providerId;
      const acceptedGeneration = authorityGeneration;
      const acceptedOperationId = operationId;
      await state.exclusive(() => {
        const key = operationKey(acceptedScope, acceptedProviderId, acceptedGeneration,
          acceptedOperationId);
        const current = state.authorities.get(key);
        if (current !== undefined) {
          state.authorities.set(key, Object.freeze({
            decision: current.decision, purpose: current.purpose,
            operationId: current.operationId, scope: current.scope,
            authorityRevision: current.authorityRevision,
            acceptedAuthorityDigest: current.acceptedAuthorityDigest,
            authorityHeadDigest: current.authorityHeadDigest,
            constraintsDigest: current.constraintsDigest,
            containmentPolicyDigest: current.containmentPolicyDigest,
            requestDigest: current.requestDigest,
            providerId: current.providerId, authorityGeneration: current.authorityGeneration,
            providerBindingDigest: current.providerBindingDigest,
            claimBindingDigest: current.claimBindingDigest,
            claimBeforeControlTime: current.claimBeforeControlTime,
            revoked: true, ownerEvidenceRef: current.ownerEvidenceRef,
          }));
        }
      });
    },
    setAvailable(nextAvailable) { available = nextAvailable; },
    async inspectConsumption(scope, providerId, authorityGeneration, operationId) {
      if (isNodeDispatchProxy(scope)) {throw new TypeError("invalid consumption selector");}
      const scopeFields = snapshotExactDispatchRecord(scope, ["tenantId", "projectId", "scopeDigest"]);
      if (scopeFields === undefined || ![scopeFields.tenantId, scopeFields.projectId,
        scopeFields.scopeDigest, providerId, authorityGeneration, operationId]
        .every(isBoundedDispatchIdentifier)) {throw new TypeError("invalid consumption selector");}
      const acceptedScope = Object.freeze({ tenantId: scopeFields.tenantId as string,
        projectId: scopeFields.projectId as string, scopeDigest: scopeFields.scopeDigest as string });
      return state.exclusive(() =>
        state.consumptionsByOperation.get(operationKey(acceptedScope, providerId,
          authorityGeneration, operationId)));
    },
  };
};
