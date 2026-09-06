import type {
  AuthorizeCredentialMaterializationInput, CredentialMaterializationAuthorizationReceipt,
  CredentialMaterializationAuthorizationV1,
} from "../../contracts/materialization-authorization-v1.js";

/** Private PA selection, supplied once by PA composition, never by request headers/body. */
export type CredentialRecipe = "codex-chatgpt" | "codex-api" | "claude-oauth" | "claude-api";
export type CredentialRenderingBinding = Omit<AuthorizeCredentialMaterializationInput,
  "authorizationRequestId" | "requestDigest" | "purpose" | "schemaVersion">;
export interface CredentialRenderingSelection {
  readonly operationRef: string;
  readonly binding: CredentialRenderingBinding;
  readonly recipe: CredentialRecipe;
  readonly operationAbortSignal: AbortSignal;
  /** Absolute performance.now() deadline in this process; no refresh or extension. */
  readonly deadline: number;
}

/** PA adapter seam only. Not a feature dependency, package export or raw-secret DTO for an ACL. */
export interface CredentialGenerationRequest {
  readonly operationRef: string;
  readonly recipe: CredentialRecipe;
  readonly authorization: CredentialMaterializationAuthorizationReceipt;
}
export interface PrivateCredentialField {
  readonly name: "token" | "accountId" | "apiKey";
  readonly valueBytes: Uint8Array;
}
export type CredentialGenerationOutcome =
  | { readonly kind: "unsupported" }
  | { readonly kind: "acquired"; readonly request: CredentialGenerationRequest;
      readonly fields: readonly PrivateCredentialField[] };
export interface CredentialGenerationAcquisition {
  /**
   * Return the exact request object. Transfer exclusive ownership of dedicated,
   * non-shared buffers, including on late completion. Never retain/mutate aliases.
   * No refresh/retry. Honor the signal; dispose unreturned material on rejection.
   * Use an ordinary native Promise and data records, with at most two buffer slots.
   * Malformed inaccessible/proxy-owned material remains the producer's cleanup duty.
   */
  acquire(request: CredentialGenerationRequest, signal: AbortSignal): Promise<CredentialGenerationOutcome>;
}

/** Trusted PA bootstrap input, never an ACL dependency or authorization receipt. */
export interface OperationCredentialMaterial {
  readonly operationRef: string;
  readonly binding: CredentialRenderingBinding;
  readonly recipe: CredentialRecipe;
  readonly fields: readonly PrivateCredentialField[];
}
export interface OperationCredentialMaterialAdmission {
  /**
   * One attempt. Acknowledges local custody only. Producer cleans any buffers still
   * attached on rejection; PA erases every transferred buffer, including partial failure.
   */
  admit(material: OperationCredentialMaterial): { readonly kind: "admitted" | "rejected" };
}
/** Private companion, wired only to the rendering owner, never to the bootstrap/ACL. */
export interface CredentialGenerationMaterialLifetime {
  acceptRequest(request: CredentialGenerationRequest): void;
  dispose(): void;
}

export interface RenderedCredentialField {
  readonly name: "Authorization" | "ChatGPT-Account-ID" | "x-api-key";
  readonly valueBytes: Uint8Array;
}
/**
 * On success these exclusive buffers transfer to the recipient (later broker ACL).
 * It must call release() in finally after copying/consuming, including on cutoff.
 * PA has erased per-call raw copies; an admitted operation seed remains until retirement.
 * Owner disposal cannot erase these transferred bytes.
 * Any recipient copy has a separate zeroization owner. Never serialize this object.
 */
export interface RenderedCredentialFields {
  readonly fields: readonly RenderedCredentialField[];
  release(): void;
}
export type CredentialRenderingOutcome =
  | { readonly kind: "rendered"; readonly credentials: RenderedCredentialFields }
  | { readonly kind: "denied" }
  | { readonly kind: "unsupported"; readonly reason: "credential_acquisition_unavailable" };
export interface CredentialRenderingOwner {
  readonly authorization: CredentialMaterializationAuthorizationV1;
  readonly rendering: {
    render(receipt: CredentialMaterializationAuthorizationReceipt): Promise<CredentialRenderingOutcome>;
  };
  /** One-way local cutoff only; conveys no durable cancellation/containment truth. */
  dispose(): void;
}
