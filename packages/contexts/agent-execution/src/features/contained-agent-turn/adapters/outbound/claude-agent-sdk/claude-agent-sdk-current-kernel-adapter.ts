import { createHash } from "node:crypto";

import type {
  ContainedTurnKernelProviderObservation,
  ContainedTurnKernelProviderPort,
} from "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnCapabilityManifest,
  ContainedTurnProviderAdapterSnapshot,
} from "../../../domain/contained-turn-authority.js";
import {
  containedTurnIdentity,
  type ContainedTurnCustodyId,
  type ContainedTurnOperationId,
  type ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import type {
  ContainedTurnProviderExecutionOutcome,
} from "../legacy/legacy-contained-turn-ports.js";
import type {
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
} from "../host-custody/custodied-provider-process.js";
import {
  ClaudeAgentSdkContainedTurnProvider,
  type ClaudeAgentSdkContainedTurnProviderOptions,
} from "./claude-agent-sdk-contained-turn-provider.js";
import type {
  ClaudeAgentSdkPrivateProjection,
} from "./claude-agent-sdk-launch-plan.js";

export interface ClaudeAgentSdkKernelPrivateExecution {
  readonly privateProjection: ClaudeAgentSdkPrivateProjection;
  readonly workspaceRef: string;
}

/**
 * Owner-private projection seam. WorkspaceId remains opaque: only the
 * workspace/Host composition owner can supply the raw canonical path and
 * private Claude configuration projection.
 */
export interface ClaudeAgentSdkKernelPrivateExecutionResolver {
  consume<Result>(input: Readonly<{
    custodyId: ContainedTurnCustodyId;
    operationId: ContainedTurnOperationId;
    workspaceId: ContainedTurnWorkspaceId;
  }>, execute: (execution: ClaudeAgentSdkKernelPrivateExecution) => Promise<Result>): Promise<Result | undefined>;
}

export interface ClaudeAgentSdkCurrentKernelAdapterOptions {
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly cancellationPollMs?: number;
  readonly clock?: ClaudeAgentSdkContainedTurnProviderOptions["clock"];
  readonly executablePath: string;
  readonly interruptGraceMs?: number;
  readonly manifest: ContainedTurnCapabilityManifest;
  readonly privateExecutions: ClaudeAgentSdkKernelPrivateExecutionResolver;
  /** The accepted Guardian-backed launcher; it performs the sole physical spawn. */
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory?: ClaudeAgentSdkContainedTurnProviderOptions["queryFactory"];
  readonly turnTimeoutMs?: number;
}

const indeterminate = (
  input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  reason: string,
): ContainedTurnKernelProviderObservation => {
  const digest = createHash("sha256").update(JSON.stringify([
    input.operationId,
    input.effectId,
    input.attemptId,
    input.custodyId,
    input.workspaceId,
    reason,
  ])).digest("hex");
  return Object.freeze({
    evidenceId: containedTurnIdentity("evidence", `evidence:claude-current-kernel:${digest}`),
    kind: "indeterminate" as const,
  });
};

/** Legacy receipt strings are intentionally discarded; they are not Host proofs. */
export const mapClaudeAgentSdkKernelObservation = (
  input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  outcome: ContainedTurnProviderExecutionOutcome,
): ContainedTurnKernelProviderObservation =>
  outcome.kind === "completed"
    ? Object.freeze({ kind: "completed" as const, outcome: outcome.outcome })
    : indeterminate(input, outcome.kind === "ambiguous" ? "sdk-ambiguous" : "sdk-not-accepted");

const sameAdapterSnapshot = (
  left: ContainedTurnProviderAdapterSnapshot,
  right: ContainedTurnProviderAdapterSnapshot,
): boolean =>
  left.adapterRevision === right.adapterRevision &&
  left.binaryRevision === right.binaryRevision &&
  left.capabilityManifestRevision === right.capabilityManifestRevision &&
  left.provider === right.provider;

export class ClaudeAgentSdkCurrentKernelAdapter implements ContainedTurnKernelProviderPort {
  public readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  public readonly manifest: ContainedTurnCapabilityManifest;
  readonly #options: ClaudeAgentSdkCurrentKernelAdapterOptions;

  public constructor(options: ClaudeAgentSdkCurrentKernelAdapterOptions) {
    if (
      options.adapterSnapshot.provider !== "claude" ||
      options.manifest.provider !== "claude" ||
      options.manifest.manifestRevision !== options.adapterSnapshot.capabilityManifestRevision
    ) {
      throw new TypeError("Claude current-kernel adapter requires one exact Claude snapshot and manifest");
    }
    this.adapterSnapshot = Object.freeze({ ...options.adapterSnapshot });
    this.manifest = Object.freeze({
      ...options.manifest,
      requiredProofKinds: Object.freeze([...options.manifest.requiredProofKinds]) as typeof options.manifest.requiredProofKinds,
      supportedModes: Object.freeze([...options.manifest.supportedModes]),
    });
    this.#options = options;
  }

  public async execute(
    input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
  ): Promise<ContainedTurnKernelProviderObservation> {
    if (
      !sameAdapterSnapshot(input.adapterSnapshot, this.adapterSnapshot) ||
      input.providerAccessSnapshot.provider !== "claude" ||
      !this.manifest.supportedModes.includes(input.intent.mode)
    ) {
      return indeterminate(input, "authority-conflict");
    }

    try {
      const outcome = await this.#options.privateExecutions.consume({
        custodyId: input.custodyId,
        operationId: input.operationId,
        workspaceId: input.workspaceId,
      }, execution => this.#executeWithPrivateProjection(input, execution));
      return outcome ?? indeterminate(input, "private-projection-absent");
    } catch {
      return indeterminate(input, "private-projection-unknown");
    }
  }

  async #executeWithPrivateProjection(
    input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0],
    execution: ClaudeAgentSdkKernelPrivateExecution,
  ): Promise<ContainedTurnKernelProviderObservation> {
    let delegatedSpawns = 0;
    const processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher = {
      get: custodyRef => this.#options.processes.get(custodyRef),
      start: (custodyRef, launch) => {
        delegatedSpawns += 1;
        if (delegatedSpawns !== 1) {
          throw new TypeError("Claude SDK may request exactly one Host-delegated spawn");
        }
        return input.start.createProcess(() => this.#options.processes.start(custodyRef, launch));
      },
    };
    const provider = new ClaudeAgentSdkContainedTurnProvider({
      ...(this.#options.cancellationPollMs === undefined ? {} : { cancellationPollMs: this.#options.cancellationPollMs }),
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
      executablePath: this.#options.executablePath,
      ...(this.#options.interruptGraceMs === undefined ? {} : { interruptGraceMs: this.#options.interruptGraceMs }),
      manifest: {
        effectClass: this.manifest.effectClass,
        providerBinding: {
          ...this.adapterSnapshot,
          credentialBindingDigest: input.providerAccessSnapshot.credentialBindingDigest,
          providerRouteRef: input.providerAccessSnapshot.providerRouteRef,
        },
        supportedModes: this.manifest.supportedModes,
      },
      privateProjections: {
        resolve: () => execution.privateProjection,
      },
      processes,
      ...(this.#options.queryFactory === undefined ? {} : { queryFactory: this.#options.queryFactory }),
      ...(this.#options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: this.#options.turnTimeoutMs }),
    });
    const outcome = await provider.execute({
      attemptId: input.attemptId,
      custody: { custodyRef: input.custodyId },
      effectId: input.effectId,
      emit: input.emit,
      intent: input.intent,
      isCancellationRequested: input.isCancellationRequested,
      operationId: input.operationId,
      workspaceRef: execution.workspaceRef,
    });
    if (delegatedSpawns !== 1) {
      return indeterminate(input, delegatedSpawns === 0 ? "sdk-spawn-absent" : "sdk-spawn-conflict");
    }
    const startObservation = await input.start.observation;
    if (startObservation.kind !== "execution_started") {
      return indeterminate(input, `host-start-${startObservation.kind}`);
    }
    return mapClaudeAgentSdkKernelObservation(input, outcome);
  }
}
