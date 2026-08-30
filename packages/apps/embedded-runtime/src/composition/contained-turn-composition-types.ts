export interface OwnerTurnObservation {
  readonly artifactManifestRef?: string;
  readonly commandId: string;
  readonly effectId: string;
  readonly operationId: string;
  readonly output: readonly {
    readonly cursor: number;
    readonly kind: "assistant" | "diagnostic" | "progress";
    readonly text: string;
  }[];
  readonly provider: string;
  readonly resultRef?: string;
  readonly revision: number;
  readonly status: "accepted" | "cancelled" | "failed" | "reconcile_required" | "running" | "succeeded";
}

type OwnerSubmitObservation = OwnerTurnObservation;

export type OwnerObservationOutcome =
  | { readonly status: "not_found" }
  | { readonly status: "observed"; readonly turn: OwnerTurnObservation };

export type OwnerSubmitOutcome =
  | { readonly code: "command_fingerprint_conflict"; readonly status: "conflict" }
  | { readonly code: "mode_unsupported" | "provider_mismatch" | "provider_unsupported"; readonly status: "unsupported" }
  | { readonly status: "denied" }
  | { readonly status: "observed"; readonly turn: OwnerSubmitObservation };
