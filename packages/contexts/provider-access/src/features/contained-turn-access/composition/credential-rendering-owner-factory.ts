import { createContainedTurnCredentialMaterializationAuthorizationV1, type MaterializationAuthorizationV1Dependencies } from "./materialization-authorization-v1-factory.js";
import { createCredentialRenderingAdapter } from "../adapters/outbound/credential-rendering-owner.js";
import { exactCredentialData } from "../adapters/outbound/credential-rendering-bytes.js";
import { signalAborted } from "../adapters/outbound/credential-rendering-lifetime.js";
import type { CredentialGenerationAcquisition, CredentialGenerationRequest, CredentialRenderingOwner, CredentialRenderingSelection } from "../adapters/outbound/credential-rendering-contracts.js";
import { exactProviderAccessDataRecord, isRuntimeProxy } from "../adapters/provider-access-data.js";
import { snapshotAuthorizationCommand } from "../domain/materialization-authorization.js";

const snapshotSelection = (value: CredentialRenderingSelection): CredentialRenderingSelection => {
  const data = exactCredentialData(value, ["operationRef", "binding", "recipe", "operationAbortSignal", "deadline"]);
  const binding = exactProviderAccessDataRecord("render binding", data.binding?.value, [
    "accessRef", "availability", "bindingRevision", "credentialBindingDigest", "credentialBindingRef", "credentialGeneration",
    "projectId", "provider", "providerAccountRef", "providerRouteRef", "revocation", "scopeDigest", "tenantId",
  ]);
  const validated = snapshotAuthorizationCommand({
    ...binding, authorizationRequestId: "boundary:validation", requestDigest: "pending",
    purpose: "contained-turn.credential-materialization-authorization/v1", schemaVersion: 1,
  });
  const recipe: unknown = data.recipe?.value;
  const provider = recipe === "codex-chatgpt" || recipe === "codex-api" ? "codex" :
    recipe === "claude-oauth" || recipe === "claude-api" ? "claude" : undefined;
  const operationRef: unknown = data.operationRef?.value;
  const deadline: unknown = data.deadline?.value;
  if (!provider || provider !== validated.provider || typeof operationRef !== "string" ||
    !/^[A-Za-z0-9:._-]{1,256}$/u.test(operationRef) || typeof deadline !== "number" ||
    !Number.isFinite(deadline) || deadline <= 0 || deadline - performance.now() > 2_147_483_647) {
    throw new TypeError("invalid credential rendering selection");
  }
  const operationAbortSignal = data.operationAbortSignal?.value as AbortSignal;
  signalAborted(operationAbortSignal); // Brand check only: no listener, timer, credential or repository effect.
  return Object.freeze({operationRef, deadline, operationAbortSignal, recipe: recipe as CredentialRenderingSelection["recipe"],
    binding: Object.freeze(binding) as unknown as CredentialRenderingSelection["binding"]});
};

const captureAcquisition = (value: CredentialGenerationAcquisition | undefined): CredentialGenerationAcquisition | undefined => {
  if (value === undefined) {return undefined;}
  const data = exactCredentialData(value, ["acquire"]);
  const method: unknown = data.acquire?.value;
  if (typeof method !== "function" || isRuntimeProxy(method)) {throw new TypeError("invalid credential acquisition capability");}
  const source = Reflect.apply(Function.prototype.toString, method, []) as string;
  if (/\{\s*\[native code\]\s*\}\s*$/u.test(source) || source.trimStart().startsWith("class")) {
    throw new TypeError("invalid credential acquisition capability");
  }
  return Object.freeze({acquire(request: CredentialGenerationRequest, signal: AbortSignal) {return Reflect.apply(method, undefined, [request, signal]);}});
};

/**
 * PA-private prerequisite. No package export until an actual PA store composition
 * exists. Existing PA application owns every decision and current binding reread.
 * Missing acquisition is explicit unsupported; this factory invents no credentials,
 * durable repository, PA/RS publication, live binding or qualification.
 */
export const createContainedTurnCredentialRenderingOwner = (
  selection: CredentialRenderingSelection, authorization: MaterializationAuthorizationV1Dependencies,
  acquisition?: CredentialGenerationAcquisition,
): CredentialRenderingOwner => createCredentialRenderingAdapter(
  snapshotSelection(selection), createContainedTurnCredentialMaterializationAuthorizationV1(authorization), captureAcquisition(acquisition),
);
