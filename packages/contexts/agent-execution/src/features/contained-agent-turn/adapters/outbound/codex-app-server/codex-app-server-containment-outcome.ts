import type { ContainedTurnProviderExecutionOutcome } from "../legacy/legacy-contained-turn-ports.js";
import { codexReceipt, type CodexReceiptIdentity } from "./codex-app-server-receipt-identity.js";

export type CodexPublicEvidenceCode =
  | "after-turn-protocol-error"
  | "before-turn-protocol-error"
  | "custody-process-lookup-failed"
  | "custody-process-missing"
  | "input-close-failed"
  | "input-close-succeeded"
  | "no-start-disproved"
  | "no-start-proved"
  | "pre-turn-error"
  | "protocol-terminal-missing"
  | "protocol-terminal-observed"
  | "stderr-drained"
  | "stderr-failed"
  | "stderr-unknown"
  | "stdout-stream-unavailable"
  | "turn-request-missing"
  | "turn-request-written"
  | "unknown-error";

export interface CodexContainmentReconciliationRequiredOutcome {
  readonly containmentRequired: true;
  readonly evidenceRef: string;
  readonly integrationRequired: "kernel-custody-containment-reconciliation/v1";
  readonly kind: "ambiguous";
  readonly outputDrainProven: false;
  readonly protocolTerminalObserved: boolean;
}

export type CodexAppServerExecutionOutcome =
  | ContainedTurnProviderExecutionOutcome
  | CodexContainmentReconciliationRequiredOutcome;

export const codexContainmentRequired = (
  identity: CodexReceiptIdentity,
  codes: readonly CodexPublicEvidenceCode[],
  protocolTerminalObserved = false,
): CodexContainmentReconciliationRequiredOutcome => ({
  containmentRequired: true,
  evidenceRef: codexReceipt("codex-provider-ambiguous", identity, codes),
  integrationRequired: "kernel-custody-containment-reconciliation/v1",
  kind: "ambiguous",
  outputDrainProven: false,
  protocolTerminalObserved,
});
