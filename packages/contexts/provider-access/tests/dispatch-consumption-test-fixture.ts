import type { ConsumeForDispatchInput, DispatchConsumptionReceipt, SettleDispatchConsumptionInput } from "../dist/index.js";
import { createDispatchConsumptionRequestDigests, type InMemoryDispatchBindingSeed } from "../dist/composition.js";
import { createInMemoryDispatchConsumptionRepository } from "../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import type {
  DispatchConsumptionRepository, DispatchConsumptionTransaction,
} from "../dist/features/contained-turn-access/application/ports/outbound/dispatch-consumption-repository.js";

export const seed = (overrides: Partial<InMemoryDispatchBindingSeed> = {}): InMemoryDispatchBindingSeed => ({
  acceptedAuthorityDigest: "authority:accepted:1", accessRef: "access:1", authorityHeadDigest: "authority:head:1",
  bindingDigest: "binding:digest:1", bindingRevision: 1, claimBeforeControlTime: 200,
  expiresAtControlTime: 300,
  credentialBindingDigest: "credential:digest:1", credentialBindingRef: "credential:binding:1",
  credentialGeneration: 1, opaqueOwnerEvidenceRef: "owner:evidence:1", projectId: "project:1",
  provider: "codex", providerAccountRef: "account:1", providerRouteRef: "route:1",
  scopeDigest: "scope:digest:1", tenantId: "tenant:1", ...overrides,
});

export const unsignedInput = (head = seed(), overrides: Partial<Omit<ConsumeForDispatchInput, "claimBindingDigest" | "requestDigest">> = {}) => ({
  binding: {
    acceptedAuthorityDigest: head.acceptedAuthorityDigest, accessRef: head.accessRef,
    authorityHeadDigest: head.authorityHeadDigest, bindingDigest: head.bindingDigest,
    bindingRevision: head.bindingRevision, credentialBindingDigest: head.credentialBindingDigest,
    credentialBindingRef: head.credentialBindingRef, credentialGeneration: head.credentialGeneration,
    providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef,
  },
  grantRequestId: "grant-request:1", operationId: "operation:1", provider: head.provider,
  purpose: "contained-turn.provider-dispatch/v1" as const,
  scope: { projectId: head.projectId, scopeDigest: head.scopeDigest, tenantId: head.tenantId },
  ...overrides,
});

export const inputFor = async (head = seed(), overrides: Parameters<typeof unsignedInput>[1] = {}): Promise<ConsumeForDispatchInput> => {
  const unsigned = unsignedInput(head, overrides);
  return { ...unsigned, ...await createDispatchConsumptionRequestDigests(unsigned) };
};

export const repositoryHarness = () => createInMemoryDispatchConsumptionRepository([{
  ...seed(), availability: "available", revocation: "active",
}], 100);

export const settlementFor = (receipt: DispatchConsumptionReceipt,
  overrides: Partial<SettleDispatchConsumptionInput> = {}): SettleDispatchConsumptionInput => ({
  consumptionDigest: receipt.consumptionDigest, disposition: "abandoned_without_claim" as const,
  expectedBinding: {
    acceptedAuthorityDigest: receipt.acceptedAuthorityDigest, accessRef: receipt.accessRef,
    authorityHeadDigest: receipt.authorityHeadDigestAtConsumption, bindingDigest: receipt.bindingDigest,
    bindingRevision: receipt.bindingRevision, credentialBindingDigest: receipt.credentialBindingDigest,
    credentialBindingRef: receipt.credentialBindingRef, credentialGeneration: receipt.credentialGeneration,
    providerAccountRef: receipt.providerAccountRef, providerRouteRef: receipt.providerRouteRef,
  },
  operationId: receipt.operationId, provider: receipt.provider, scope: receipt.scope,
  settlementRequestId: "settlement:1", ...overrides,
});

type RepositoryRead = "findBindingHead" | "findConsumption" | "findGrantRequest" | "findSettlement" | "findSettlementByConsumption";
export const repositoryReadOverride = (base: DispatchConsumptionRepository, method: RepositoryRead, value: unknown): DispatchConsumptionRepository => ({
  observeGrantRequest: input => base.observeGrantRequest(input),
  transact: (selector, work) => base.transact(selector, transaction => work({
    controlTime: () => transaction.controlTime(),
    findBindingHead: () => method === "findBindingHead" ? Promise.resolve(value as never) : transaction.findBindingHead(),
    findConsumption: () => method === "findConsumption" ? Promise.resolve(value as never) : transaction.findConsumption(),
    findGrantRequest: () => method === "findGrantRequest" ? Promise.resolve(value as never) : transaction.findGrantRequest(),
    findSettlement: () => method === "findSettlement" ? Promise.resolve(value as never) : transaction.findSettlement(),
    findSettlementByConsumption: () => method === "findSettlementByConsumption" ? Promise.resolve(value as never) : transaction.findSettlementByConsumption(),
    isBindingConsumed: () => transaction.isBindingConsumed(), markBindingConsumed: receipt => transaction.markBindingConsumed(receipt),
    saveGrantRequest: entry => transaction.saveGrantRequest(entry), saveSettlement: outcome => transaction.saveSettlement(outcome),
  } as DispatchConsumptionTransaction)),
});
