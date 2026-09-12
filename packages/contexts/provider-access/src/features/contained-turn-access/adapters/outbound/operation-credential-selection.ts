import type { CredentialRenderingSelection } from "./credential-rendering-contracts.js";
import { exactCredentialData } from "./credential-rendering-bytes.js";
import { signalAborted } from "./credential-rendering-lifetime.js";
import { exactProviderAccessDataRecord } from "../provider-access-data.js";
import { snapshotAuthorizationCommand } from "../../domain/materialization-authorization.js";

export const snapshotCredentialRenderingSelection = (value: CredentialRenderingSelection): CredentialRenderingSelection => {
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
    !Number.isFinite(deadline) || deadline <= 0) {
    throw new TypeError("invalid credential rendering selection");
  }
  const operationAbortSignal = data.operationAbortSignal?.value as AbortSignal;
  signalAborted(operationAbortSignal); // Brand check only: no listener, timer, credential or repository effect.
  return Object.freeze({operationRef, deadline, operationAbortSignal, recipe: recipe as CredentialRenderingSelection["recipe"],
    binding: Object.freeze(binding) as unknown as CredentialRenderingSelection["binding"]});
};
