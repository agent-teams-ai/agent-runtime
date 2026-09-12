import { createContainedTurnCredentialMaterializationAuthorizationV1, type MaterializationAuthorizationV1Dependencies } from "./materialization-authorization-v1-factory.js";
import { createCredentialRenderingAdapter } from "../adapters/outbound/credential-rendering-owner.js";
import { exactCredentialData } from "../adapters/outbound/credential-rendering-bytes.js";
import type { CredentialGenerationAcquisition, CredentialGenerationRequest, CredentialRenderingOwner, CredentialRenderingSelection } from "../adapters/outbound/credential-rendering-contracts.js";
import { isRuntimeProxy } from "../adapters/provider-access-data.js";
import { snapshotCredentialRenderingSelection } from "../adapters/outbound/operation-credential-selection.js";
import { createOperationCredentialGenerationAcquisition } from "../adapters/outbound/operation-credential-generation-acquisition.js";

const captureAcquisition = (value: CredentialGenerationAcquisition | undefined): CredentialGenerationAcquisition | undefined => {
  if (value === undefined) {return undefined;}
  const data = exactCredentialData(value, ["acquire"]);
  const method: unknown = data.acquire?.value;
  if (typeof method !== "function" || isRuntimeProxy(method)) {throw new TypeError("invalid credential acquisition capability");}
  // Best-effort shape heuristic, not security proof of the function's behavior
  // or provenance: arrow wrappers pass and legitimate bound methods are rejected.
  // PA authorization and current binding rereads remain independently required.
  const source = Reflect.apply(Function.prototype.toString, method, []) as string;
  if (/\{\s*\[native code\]\s*\}\s*$/u.test(source) || source.trimStart().startsWith("class")) {
    throw new TypeError("invalid credential acquisition capability");
  }
  return Object.freeze({acquire(request: CredentialGenerationRequest, signal: AbortSignal) {return Reflect.apply(method, undefined, [request, signal]);}});
};

/**
 * Legacy PA-private external acquisition entrypoint; it retains no operation seed.
 * Missing acquisition is explicit unsupported. The existing PA application owns
 * every authorization decision and current binding reread.
 */
export const createContainedTurnCredentialRenderingOwner = (
  selection: CredentialRenderingSelection, authorization: MaterializationAuthorizationV1Dependencies,
  acquisition?: CredentialGenerationAcquisition,
): CredentialRenderingOwner => createCredentialRenderingAdapter(
  snapshotCredentialRenderingSelection(selection), createContainedTurnCredentialMaterializationAuthorizationV1(authorization), captureAcquisition(acquisition),
);

/** Trusted PA bootstrap retains admission; consumers receive only owner capabilities. */
export const createAdmittedMaterialCredentialRenderingOwner = (
  selection: CredentialRenderingSelection, authorization: MaterializationAuthorizationV1Dependencies,
) => {
  const captured = snapshotCredentialRenderingSelection(selection);
  const authority = createContainedTurnCredentialMaterializationAuthorizationV1(authorization);
  const material = createOperationCredentialGenerationAcquisition(captured);
  return Object.freeze({
    owner: createCredentialRenderingAdapter(captured, authority, material.acquisition, material.lifetime),
    admission: material.admission,
  });
};
