import assert from "node:assert/strict";
import { createCredentialMaterializationRequestDigest } from "../../../dist/composition.js";
import { createContainedTurnCredentialRenderingOwner } from "../../../dist/features/contained-turn-access/composition/credential-rendering-owner-factory.js";
import { createContainedTurnCredentialMaterializationAuthorizationV1 } from "../../../dist/features/contained-turn-access/composition/materialization-authorization-v1-factory.js";
import { createInMemoryDispatchConsumptionRepository } from "../../../dist/features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import { createSha256DispatchConsumptionDigest } from "../../../dist/features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import type {
  CredentialGenerationAcquisition, CredentialGenerationOutcome, CredentialGenerationRequest, CredentialRecipe,
  CredentialRenderingOutcome, CredentialRenderingSelection,
} from "../../../dist/features/contained-turn-access/adapters/outbound/credential-rendering-contracts.js";
import type { AuthorizeCredentialMaterializationInput } from "../../../dist/index.js";
import { seed } from "./dispatch-consumption-test-fixture.ts";

export const syntheticBytes = (text = "fixture-pa"): Uint8Array => new TextEncoder().encode(text);
export const erased = (bytes: Uint8Array): void => {assert.ok(bytes.every(byte => byte === 0));};
export const rendered = (outcome: CredentialRenderingOutcome) => {
  assert.equal(outcome.kind, "rendered");
  if (outcome.kind !== "rendered") {throw new Error("fixture expected rendering");}
  return outcome.credentials;
};
export const generation = (request: CredentialGenerationRequest): CredentialGenerationOutcome => ({
  kind: "acquired", request, fields: request.recipe === "codex-chatgpt"
    ? [{name: "token", valueBytes: syntheticBytes()}, {name: "accountId", valueBytes: syntheticBytes("fixture-account")}]
    : [{name: request.recipe === "claude-api" ? "apiKey" : "token", valueBytes: syntheticBytes("fixture-key")}],
});
export const selectorFor = (request: AuthorizeCredentialMaterializationInput) => ({
  authorizationRequestId: request.authorizationRequestId, requestDigest: request.requestDigest,
  tenantId: request.tenantId, projectId: request.projectId, scopeDigest: request.scopeDigest, provider: request.provider,
});

/** Existing in-memory PA repository is a synthetic fixture only, never durability evidence. */
export const renderingFixture = (recipe: CredentialRecipe = "codex-chatgpt",
  selected: Readonly<{head?: Partial<ReturnType<typeof seed>>; operationRef?: string}> = {}) => {
  const head = {...seed({provider: recipe.startsWith("codex") ? "codex" : "claude"}),
    availability: "available" as const, revocation: "active" as const, ...selected.head};
  const repositoryFixture = createInMemoryDispatchConsumptionRepository([head], 100);
  const controller = new AbortController();
  const binding: CredentialRenderingSelection["binding"] = {
    accessRef: head.accessRef, availability: head.availability, bindingRevision: head.bindingRevision,
    credentialBindingDigest: head.credentialBindingDigest, credentialBindingRef: head.credentialBindingRef,
    credentialGeneration: head.credentialGeneration, projectId: head.projectId, provider: head.provider,
    providerAccountRef: head.providerAccountRef, providerRouteRef: head.providerRouteRef, revocation: head.revocation,
    scopeDigest: head.scopeDigest, tenantId: head.tenantId,
  };
  const selection = {operationRef: selected.operationRef ?? "operation:fixture", recipe, binding, operationAbortSignal: controller.signal,
    deadline: performance.now() + 60_000};
  const events: string[] = [];
  const requests: CredentialGenerationRequest[] = [];
  const raw: CredentialGenerationOutcome[] = [];
  const repository = repositoryFixture.materializationRepository;
  const dependencies = {
    digest: createSha256DispatchConsumptionDigest(),
    repository: {
      observeAuthorizationRequest: repository.observeAuthorizationRequest,
      async transact<T>(...args: Parameters<typeof repository.transact<T>>) {
        events.push("pa-transaction");
        return repository.transact(...args);
      },
    },
  };
  const acquisition: CredentialGenerationAcquisition = {
    async acquire(request, _signal) {
      events.push("acquire"); requests.push(request);
      const result = generation(request); raw.push(result); return result;
    },
  };
  const create = (source: CredentialGenerationAcquisition | undefined = acquisition) =>
    createContainedTurnCredentialRenderingOwner(selection, dependencies, source);
  const request = async (changes: Partial<AuthorizeCredentialMaterializationInput> = {}) => {
    const unsigned = {...binding, authorizationRequestId: "request:fixture", purpose:
      "contained-turn.credential-materialization-authorization/v1" as const, schemaVersion: 1 as const, ...changes};
    const {requestDigest: _requestDigest, ...data} = unsigned as AuthorizeCredentialMaterializationInput;
    return {...data, requestDigest: await createCredentialMaterializationRequestDigest(data)};
  };
  const fresh = async (owner: ReturnType<typeof create>, input?: AuthorizeCredentialMaterializationInput) => {
    const outcome = await owner.authorization.authorize(input ?? await request());
    assert.equal(outcome.kind, "authorized");
    if (outcome.kind !== "authorized") {throw new Error("fixture expected fresh authorization");}
    return outcome.receipt;
  };
  return {head, selection, dependencies, acquisition, controller, events, requests, raw, request, fresh, create,
    control: repositoryFixture.control, application: createContainedTurnCredentialMaterializationAuthorizationV1(dependencies)};
};
