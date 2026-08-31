import type { CodexEndpointPathObservation } from "./codex-app-server-path-identity.js";

export interface CodexEffectCustodyExecution {
  readonly attemptId: string;
  readonly custodyRef: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly workspaceRef: string;
}

export interface CodexEffectCustodyRequest extends CodexEffectCustodyExecution {
  readonly endpointObservations: readonly CodexEndpointPathObservation[];
  readonly itemId: string;
  readonly itemType: "commandExecution" | "fileChange";
  readonly phase: "completed" | "started" | "terminal" | "updated";
  readonly priorAdmission?: object;
}

/**
 * Codex-owned anti-corruption seam for Host/workspace custody evidence.
 *
 * The implementation is an authority, not a caller assertion: it must consume
 * already-proven opened-object and workspace-descriptor evidence. The returned
 * object is opaque to Codex and must remain identity-stable for every later
 * phase of the same effect. Returning undefined keeps the provider boundary
 * fail-closed.
 */
export interface CodexEffectCustodyAuthority {
  admit(request: CodexEffectCustodyRequest): object | undefined;
}

export interface CodexEffectCustodyBinding {
  readonly authority: CodexEffectCustodyAuthority;
  readonly execution: CodexEffectCustodyExecution;
}
