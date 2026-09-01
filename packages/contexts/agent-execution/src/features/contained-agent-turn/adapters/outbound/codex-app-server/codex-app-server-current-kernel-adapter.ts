import type {
  ContainedTurnKernelProviderPort,
  ContainedTurnKernelProviderObservation,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import {
  CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  type ContainedTurnCapabilityManifest,
  type ContainedTurnProviderAdapterSnapshot,
} from "../../../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../../../domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../domain/contained-turn-identities.js";
import type { ContainedTurnCustodyHandle } from "../legacy/legacy-contained-turn-ports.js";
import { CodexAppServerContainedTurnProvider } from "./codex-app-server-contained-turn-provider.js";
import {
  CODEX_APP_SERVER_LINUX_X64_TUPLE,
  selectCodexAppServerPlatformTuple,
  type CodexAppServerPlatformTarget,
  type CodexAppServerPlatformTuple,
} from "./codex-app-server-platform-tuple.js";

type KernelExecutionInput = Parameters<ContainedTurnKernelProviderPort["execute"]>[0];
const executeReviewedCodexProtocol = CodexAppServerContainedTurnProvider.prototype.execute;

export interface PreparedCodexAppServerKernelAttempt {
  /**
   * Called exactly once through the Host-owned delegated-start wrapper. It is
   * the only seam allowed to create the fresh provider process and to resolve
   * the owner-private raw workspace path.
   */
  createProcess(): Readonly<{
    custody: ContainedTurnCustodyHandle;
    kernelCustodyId: KernelExecutionInput["custodyId"];
    provider: CodexAppServerContainedTurnProvider;
    workspaceRef: string;
  }>;
}

export interface CodexAppServerKernelAttemptFactory {
  prepare(input: Readonly<{
    adapterSnapshot: KernelExecutionInput["adapterSnapshot"];
    attemptId: KernelExecutionInput["attemptId"];
    authorityVectorDigest: KernelExecutionInput["authorityVectorDigest"];
    custodyId: KernelExecutionInput["custodyId"];
    effectId: KernelExecutionInput["effectId"];
    intent: KernelExecutionInput["intent"];
    operationId: KernelExecutionInput["operationId"];
    providerAccessSnapshot: KernelExecutionInput["providerAccessSnapshot"];
    workspaceId: KernelExecutionInput["workspaceId"];
  }>): Promise<PreparedCodexAppServerKernelAttempt>;
}

export interface CodexAppServerCurrentKernelAdapterOptions {
  readonly attempts: CodexAppServerKernelAttemptFactory;
  readonly platformTarget: CodexAppServerPlatformTarget;
}

export const CODEX_APP_SERVER_CURRENT_KERNEL_ADAPTER_SNAPSHOT:
ContainedTurnProviderAdapterSnapshot = Object.freeze({
  adapterRevision: CODEX_APP_SERVER_LINUX_X64_TUPLE.adapterRevision,
  binaryRevision: CODEX_APP_SERVER_LINUX_X64_TUPLE.binaryRevision,
  capabilityManifestRevision: CODEX_APP_SERVER_LINUX_X64_TUPLE.protocolRevision,
  provider: "codex",
});

export const CODEX_APP_SERVER_CURRENT_KERNEL_MANIFEST:
ContainedTurnCapabilityManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation",
  effectClass: "contained_unmediated_effect",
  manifestRevision: CODEX_APP_SERVER_LINUX_X64_TUPLE.protocolRevision,
  manifestVersion: 1,
  provider: "codex",
  providerAttemptCardinality: "at_most_one",
  requiredProofKinds: CONTAINED_TURN_REQUIRED_PROOF_KINDS,
  resourceScopeRevision: "contained-workspace-network-credential:1",
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed",
});

const sameAdapterSnapshot = (
  value: KernelExecutionInput["adapterSnapshot"],
  platformTuple: CodexAppServerPlatformTuple,
): boolean => value.provider === "codex"
  && value.adapterRevision === platformTuple.adapterRevision
  && value.binaryRevision === platformTuple.binaryRevision
  && value.capabilityManifestRevision === platformTuple.protocolRevision;

const indeterminate = (
  input: KernelExecutionInput,
  reason: string,
): ContainedTurnKernelProviderObservation => Object.freeze({
  evidenceId: containedTurnIdentity(
    "evidence",
    `evidence:codex-current-kernel:${digestContainedTurnCanonicalValue({
      adapterRevision: input.adapterSnapshot.adapterRevision,
      attemptId: input.attemptId,
      custodyId: input.custodyId,
      effectId: input.effectId,
      operationId: input.operationId,
      reason,
      workspaceId: input.workspaceId,
    })}`,
  ),
  kind: "indeterminate",
});

const matchesExecutionAuthority = (
  provider: CodexAppServerContainedTurnProvider,
  input: KernelExecutionInput,
): boolean => {
  if (!(provider instanceof CodexAppServerContainedTurnProvider)) {return false;}
  const binding = provider.manifest.providerBinding;
  return binding.provider === "codex"
    && binding.adapterRevision === input.adapterSnapshot.adapterRevision
    && binding.binaryRevision === input.adapterSnapshot.binaryRevision
    && binding.capabilityManifestRevision === input.adapterSnapshot.capabilityManifestRevision
    && binding.credentialBindingDigest === input.providerAccessSnapshot.credentialBindingDigest
    && binding.providerRouteRef === input.providerAccessSnapshot.providerRouteRef
    && provider.manifest.supportedModes.includes(input.intent.mode);
};

export class CodexAppServerCurrentKernelAdapter implements ContainedTurnKernelProviderPort {
  public readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  public readonly manifest: ContainedTurnCapabilityManifest;
  readonly #attempts: CodexAppServerKernelAttemptFactory;
  readonly #platformTuple: CodexAppServerPlatformTuple;

  public constructor(options: CodexAppServerCurrentKernelAdapterOptions) {
    this.#attempts = options.attempts;
    this.#platformTuple = selectCodexAppServerPlatformTuple(options.platformTarget);
    this.adapterSnapshot = Object.freeze({
      adapterRevision: this.#platformTuple.adapterRevision,
      binaryRevision: this.#platformTuple.binaryRevision,
      capabilityManifestRevision: this.#platformTuple.protocolRevision,
      provider: "codex",
    });
    this.manifest = Object.freeze({
      ...CODEX_APP_SERVER_CURRENT_KERNEL_MANIFEST,
      manifestRevision: this.#platformTuple.protocolRevision,
    });
  }

  public async execute(input: KernelExecutionInput): Promise<ContainedTurnKernelProviderObservation> {
    if (!sameAdapterSnapshot(input.adapterSnapshot, this.#platformTuple)
      || input.providerAccessSnapshot.provider !== "codex") {
      return indeterminate(input, "authority-identity-mismatch");
    }

    let prepared: PreparedCodexAppServerKernelAttempt;
    try {
      prepared = await this.#attempts.prepare({
        adapterSnapshot: input.adapterSnapshot,
        attemptId: input.attemptId,
        authorityVectorDigest: input.authorityVectorDigest,
        custodyId: input.custodyId,
        effectId: input.effectId,
        intent: input.intent,
        operationId: input.operationId,
        providerAccessSnapshot: input.providerAccessSnapshot,
        workspaceId: input.workspaceId,
      });
    } catch {
      return indeterminate(input, "attempt-preparation-unknown");
    }

    let attempt: ReturnType<PreparedCodexAppServerKernelAttempt["createProcess"]>;
    try {
      attempt = input.start.createProcess(() => prepared.createProcess());
    } catch {
      return indeterminate(input, "delegated-process-start-unknown");
    }
    if (attempt.kernelCustodyId !== input.custodyId ||
      typeof attempt.custody.custodyRef !== "string" || attempt.custody.custodyRef.length === 0
      || !matchesExecutionAuthority(attempt.provider, input)) {
      return indeterminate(input, "prepared-attempt-identity-mismatch");
    }

    let outputOpen = true;
    let nextCursor = 0;
    try {
      const outcome = await executeReviewedCodexProtocol.call(attempt.provider, {
        attemptId: input.attemptId,
        custody: attempt.custody,
        effectId: input.effectId,
        emit: async chunk => {
          if (!outputOpen) {return;}
          if (chunk.cursor !== nextCursor) {
            throw new Error("Codex output cursor is not contiguous");
          }
          nextCursor += 1;
          await input.emit(chunk);
        },
        intent: input.intent,
        isCancellationRequested: input.isCancellationRequested,
        operationId: input.operationId,
        workspaceRef: attempt.workspaceRef,
      });
      outputOpen = false;
      if (outcome.kind !== "completed") {
        return indeterminate(input, outcome.kind === "not_accepted"
          ? "protocol-terminal-not-accepted"
          : "protocol-terminal-unknown");
      }
      return Object.freeze({ kind: "completed", outcome: outcome.outcome });
    } catch {
      return indeterminate(input, "protocol-execution-unknown");
    } finally {
      outputOpen = false;
    }
  }
}
