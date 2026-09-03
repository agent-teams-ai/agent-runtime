/**
 * Explicit anti-corruption boundary for pre-kernel adapters.
 *
 * These contracts are not application authority and are intentionally absent
 * from package exports. They exist only until each outer adapter can emit the
 * kernel's typed proof packet directly.
 */
import type { ContainedTurnCapabilityManifest, ContainedTurnIntent } from "../../../domain/contained-turn-authority.js";
import type { ContainedTurnOutputKind, ContainedTurnProviderBinding } from "../../../contracts/contained-agent-turn.js";
import type { ContainedTurnCustodyHandle } from "../host-custody/custodied-provider-process.js";
export type { ContainedTurnCustodyHandle } from "../host-custody/custodied-provider-process.js";

export type ContainedTurnAdapterCapabilityManifest = Pick<ContainedTurnCapabilityManifest, "effectClass" | "supportedModes"> & {
  readonly providerBinding: ContainedTurnProviderBinding;
};

export type ContainedTurnProviderExecutionOutcome =
  | { readonly acceptanceReceiptRef: string; readonly effectDisposition: "committed" | "not_committed"; readonly effectReceiptRef: string; readonly executionReceiptRef: string; readonly kind: "completed"; readonly outcome: "cancelled" | "failed" | "succeeded"; readonly outputDrainReceiptRef: string }
  | { readonly effectReceiptRef: string; readonly executionReceiptRef: string; readonly kind: "not_accepted"; readonly outputDrainReceiptRef: string; readonly providerReceiptRef: string }
  | { readonly evidenceRef: string; readonly kind: "ambiguous" };

export interface ContainedTurnProviderPort {
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  execute(input: {
    readonly attemptId: string;
    readonly custody: ContainedTurnCustodyHandle;
    readonly effectId: string;
    readonly intent: ContainedTurnIntent;
    readonly operationId: string;
    readonly workspaceRef: string;
    readonly isCancellationRequested: () => Promise<boolean>;
    readonly emit: (chunk: { readonly cursor: number; readonly kind: ContainedTurnOutputKind; readonly text: string }) => Promise<void>;
  }): Promise<ContainedTurnProviderExecutionOutcome>;
}
