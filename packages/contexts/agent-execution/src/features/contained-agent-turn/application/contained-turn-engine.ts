import type {
  ContainedTurnFeatureApi,
  ContainedTurnOperationRef,
  ObserveContainedTurnInput,
  ObserveContainedTurnOutcome,
  RequestContainedTurnCancellationInput,
  RequestContainedTurnCancellationOutcome,
  SubmitContainedTurnInput,
  SubmitContainedTurnOptions,
  SubmitContainedTurnOutcome,
} from "../contracts/contained-agent-turn.js";
import {
  containedTurnView,
  type ContainedTurnMutation,
  type ContainedTurnOperation,
} from "../domain/contained-turn-operation.js";
import { isContainedTurnMutationSatisfied } from "../domain/contained-turn-mutation-satisfaction.js";
import type {
  ContainedTurnArtifactPort,
  ContainedTurnOperationStore,
  ContainedTurnProviderPort,
  ContainedTurnSecurityPort,
  ContainedTurnWorkspacePort,
  ProviderProcessCustodyPort,
} from "./ports/outbound/contained-turn-ports.js";

const MAX_COMMAND_ID_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_OUTPUT_CHUNKS = 2_048;
const MAX_OUTPUT_TEXT_LENGTH = 2_000_000;
const MAX_PROMPT_LENGTH = 65_536;
const MAX_CAS_RETRIES = 32;

export interface ContainedTurnEngineDependencies {
  readonly artifacts: ContainedTurnArtifactPort;
  readonly custody: ProviderProcessCustodyPort;
  readonly operationStore: ContainedTurnOperationStore;
  readonly provider: ContainedTurnProviderPort;
  readonly security: ContainedTurnSecurityPort;
  readonly workspace: ContainedTurnWorkspacePort;
}

const boundedText = (name: string, value: string, maximum: number): string => {
  if (value.length === 0 || value.length > maximum || value.includes("\u0000")) {
    throw new TypeError(`${name} must contain 1..${maximum} safe characters`);
  }
  return value;
};

const copyInput = (input: SubmitContainedTurnInput): SubmitContainedTurnInput => Object.freeze({
  commandId: boundedText("commandId", input.commandId, MAX_COMMAND_ID_LENGTH),
  expectedProvider: input.expectedProvider,
  intent: Object.freeze({
    mode: input.intent.mode,
    prompt: boundedText("prompt", input.intent.prompt, MAX_PROMPT_LENGTH),
  }),
  scope: Object.freeze({
    projectId: boundedText("projectId", input.scope.projectId, MAX_IDENTIFIER_LENGTH),
    tenantId: boundedText("tenantId", input.scope.tenantId, MAX_IDENTIFIER_LENGTH),
  }),
});

const copyOperationRef = <Input extends ContainedTurnOperationRef>(input: Input): ContainedTurnOperationRef => Object.freeze({
  operationId: boundedText("operationId", input.operationId, MAX_IDENTIFIER_LENGTH),
  scope: Object.freeze({
    projectId: boundedText("projectId", input.scope.projectId, MAX_IDENTIFIER_LENGTH),
    tenantId: boundedText("tenantId", input.scope.tenantId, MAX_IDENTIFIER_LENGTH),
  }),
});

const hasScope = (operation: ContainedTurnOperation, scope: ContainedTurnOperationRef["scope"]): boolean =>
  operation.scope.projectId === scope.projectId && operation.scope.tenantId === scope.tenantId;

const notifyAccepted = (
  options: SubmitContainedTurnOptions | undefined,
  operation: ContainedTurnOperation,
): void => {
  try {
    options?.onAccepted?.(Object.freeze({
      operationId: operation.operationId,
      scope: Object.freeze({ ...operation.scope }),
    }));
  } catch {
    // Acceptance observation is not operation authority and cannot unwind a durable accept.
  }
};

const createCas = (store: ContainedTurnOperationStore) => async (
  initial: ContainedTurnOperation,
  mutation: ContainedTurnMutation,
): Promise<ContainedTurnOperation> => {
  let current = initial;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    if (isContainedTurnMutationSatisfied(current, mutation)) {return current;}
    const result = await store.compareAndSet({
      expectedRevision: current.revision,
      mutation,
      operationId: current.operationId,
    });
    if (result.kind === "applied") {return result.operation;}
    if (result.kind === "not_found") {throw new Error("contained turn disappeared during transition");}
    current = result.current;
  }
  throw new Error("contained turn CAS retry budget exhausted");
};

const terminalizeOperation = async (
  initial: ContainedTurnOperation,
  store: ContainedTurnOperationStore,
): Promise<ContainedTurnOperation> => {
  let current = initial;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    if (current.terminal.kind === "terminal") {return current;}
    const result = await store.terminalize({
      expectedRevision: current.revision,
      operationId: current.operationId,
    });
    if (result.kind === "applied") {return result.operation;}
    if (result.kind === "not_found") {throw new Error("contained turn disappeared before terminal commit");}
    current = result.current;
  }
  throw new Error("contained turn terminal CAS retry budget exhausted");
};

const closePreventedOperation = async (
  operation: ContainedTurnOperation,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  const cas = createCas(dependencies.operationStore);
  let current = operation;
  if (current.output.kind === "open") {
    current = await cas(current, { kind: "output_sealed", receiptRef: current.dispatch.kind === "prevented" ? current.dispatch.receiptRef : "proved-no-output" });
  }
  if (current.workspace.kind !== "bound") {return current;}
  if (current.artifact.kind === "open") {
    const sealed = await dependencies.artifacts.seal({
      operationId: current.operationId,
      output: current.output.chunks,
      workspaceRef: current.workspace.workspaceRef,
    });
    current = await cas(current, { kind: "artifacts_sealed", manifestRef: sealed.manifestRef, receiptRef: sealed.manifestReceiptRef });
    current = await cas(current, { kind: "result_published", receiptRef: sealed.resultReceiptRef, resultRef: sealed.resultRef });
  }
  if (current.workspace.kind === "bound") {
    const closure = await dependencies.workspace.close(current.workspace.workspaceRef);
    current = await cas(current, { kind: "workspace_closed", receiptRef: closure.receiptRef });
  }
  return terminalizeOperation(current, dependencies.operationStore);
};

const preventBeforeDispatch = async (
  operation: ContainedTurnOperation,
  proofRef: string,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  let current = operation;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    if (current.dispatch.kind !== "unclaimed") {break;}
    const prevented = await dependencies.operationStore.preventDispatch({
      expectedRevision: current.revision,
      operationId: current.operationId,
      proofRef,
    });
    if (prevented.kind === "applied") {
      current = prevented.operation;
      break;
    }
    if (prevented.kind === "not_found") {return current;}
    current = prevented.current;
  }
  return current.dispatch.kind === "prevented"
    ? closePreventedOperation(current, dependencies)
    : current;
};

const markAmbiguous = async (
  operation: ContainedTurnOperation,
  evidenceRef: string,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  if (operation.terminal.kind === "terminal") {return operation;}
  const cas = createCas(dependencies.operationStore);
  let current = operation;
  if (current.reconciliation.kind === "none") {
    current = await cas(current, { evidenceRef, kind: "reconciliation_required" });
  }
  if (current.providerAcceptance.kind === "unobserved") {current = await cas(current, { evidenceRef, kind: "provider_acceptance_unknown" });}
  if (current.execution.kind === "not_started" || current.execution.kind === "running") {current = await cas(current, { evidenceRef, kind: "execution_unknown" });}
  if (current.effect.kind === "unresolved") {current = await cas(current, { evidenceRef, kind: "effect_ambiguous" });}
  if (current.dispatch.kind === "claimed" && current.containment.kind === "pending") {
    const containment = await dependencies.custody.requestContainment({
      attemptId: current.dispatch.attemptId,
      operationId: current.operationId,
    });
    current = containment.kind === "contained"
      ? await cas(current, { kind: "containment_recorded", receiptRef: containment.receiptRef })
      : await cas(current, { evidenceRef: containment.evidenceRef, kind: "containment_unproven" });
  }
  if (current.workspace.kind === "bound") {
    await dependencies.workspace.quarantine({ evidenceRef, workspaceRef: current.workspace.workspaceRef });
    current = await cas(current, { evidenceRef, kind: "workspace_quarantined" });
  }
  return current;
};

const closeClaimedWithoutProvider = async (
  operation: ContainedTurnOperation,
  receiptRef: string,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  if (operation.workspace.kind !== "bound") {throw new Error("contained turn lost workspace before no-provider closure");}
  const cas = createCas(dependencies.operationStore);
  let current = operation;
  current = await cas(current, { kind: "provider_not_accepted", receiptRef });
  current = await cas(current, { kind: "execution_closed", outcome: "cancelled", receiptRef });
  current = await cas(current, { kind: "output_sealed", receiptRef });
  current = await cas(current, { disposition: "not_committed", kind: "effect_resolved", receiptRef });
  current = await cas(current, { kind: "containment_recorded", receiptRef });
  const sealed = await dependencies.artifacts.seal({
    operationId: current.operationId,
    output: current.output.chunks,
    workspaceRef: operation.workspace.workspaceRef,
  });
  current = await cas(current, { kind: "artifacts_sealed", manifestRef: sealed.manifestRef, receiptRef: sealed.manifestReceiptRef });
  current = await cas(current, { kind: "result_published", receiptRef: sealed.resultReceiptRef, resultRef: sealed.resultRef });
  const workspaceClosure = await dependencies.workspace.close(operation.workspace.workspaceRef);
  current = await cas(current, { kind: "workspace_closed", receiptRef: workspaceClosure.receiptRef });
  return terminalizeOperation(current, dependencies.operationStore);
};

const completeClaimedOperation = async (
  operation: ContainedTurnOperation,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  if (operation.dispatch.kind !== "claimed" || operation.workspace.kind !== "bound") {
    throw new Error("contained turn lost claimed workspace authority");
  }
  const cas = createCas(dependencies.operationStore);
  const attemptId = operation.dispatch.attemptId;
  const workspaceRef = operation.workspace.workspaceRef;
  let current = operation;
  try {
    const custody = await dependencies.custody.open({
      attemptId,
      operationId: current.operationId,
      providerBinding: current.providerBinding,
      workspaceRef,
    });
    current = await cas(current, { kind: "execution_started" });
    if (current.cancellation.kind === "requested") {
      const containment = await dependencies.custody.requestContainment({
        attemptId,
        custodyRef: custody.custodyRef,
        operationId: current.operationId,
      });
      if (containment.kind === "contained") {
        return closeClaimedWithoutProvider(current, containment.receiptRef, dependencies);
      }
      current = await cas(current, { evidenceRef: containment.evidenceRef, kind: "containment_unproven" });
      return markAmbiguous(current, containment.evidenceRef, dependencies);
    }
    let outputTextLength = current.output.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
    const providerOutcome = await dependencies.provider.execute({
      attemptId,
      custody,
      effectId: current.effectId,
      intent: current.intent,
      operationId: current.operationId,
      workspaceRef,
      isCancellationRequested: async () => {
        const observed = await dependencies.operationStore.read(current.operationId);
        return observed?.cancellation.kind === "requested";
      },
      emit: async chunk => {
        if (chunk.cursor >= MAX_OUTPUT_CHUNKS || outputTextLength + chunk.text.length > MAX_OUTPUT_TEXT_LENGTH) {
          throw new Error("provider output exceeded contained turn bounds");
        }
        current = await cas(current, { cursor: chunk.cursor, kind: "output_appended", outputKind: chunk.kind, text: chunk.text });
        outputTextLength += chunk.text.length;
      },
    });
    if (providerOutcome.kind === "ambiguous") {return markAmbiguous(current, providerOutcome.evidenceRef, dependencies);}
    current = providerOutcome.kind === "completed"
      ? await cas(current, { kind: "provider_accepted", receiptRef: providerOutcome.acceptanceReceiptRef })
      : await cas(current, { kind: "provider_not_accepted", receiptRef: providerOutcome.providerReceiptRef });
    current = await cas(current, {
      kind: "execution_closed",
      outcome: providerOutcome.kind === "completed" ? providerOutcome.outcome : "failed",
      receiptRef: providerOutcome.executionReceiptRef,
    });
    current = await cas(current, { kind: "output_sealed", receiptRef: providerOutcome.outputDrainReceiptRef });
    current = await cas(current, {
      disposition: providerOutcome.kind === "completed" ? providerOutcome.effectDisposition : "not_committed",
      kind: "effect_resolved",
      receiptRef: providerOutcome.effectReceiptRef,
    });
    const containment = await dependencies.custody.requestContainment({
      attemptId,
      custodyRef: custody.custodyRef,
      operationId: current.operationId,
    });
    if (containment.kind === "unproven") {return markAmbiguous(current, containment.evidenceRef, dependencies);}
    current = await cas(current, { kind: "containment_recorded", receiptRef: containment.receiptRef });
    const sealed = await dependencies.artifacts.seal({ operationId: current.operationId, output: current.output.chunks, workspaceRef });
    current = await cas(current, { kind: "artifacts_sealed", manifestRef: sealed.manifestRef, receiptRef: sealed.manifestReceiptRef });
    current = await cas(current, { kind: "result_published", receiptRef: sealed.resultReceiptRef, resultRef: sealed.resultRef });
    const workspaceClosure = await dependencies.workspace.close(workspaceRef);
    current = await cas(current, { kind: "workspace_closed", receiptRef: workspaceClosure.receiptRef });
    return terminalizeOperation(current, dependencies.operationStore);
  } catch {
    return markAmbiguous(current, `provider-ambiguous:${current.operationId}`, dependencies);
  }
};

const claimDispatch = async (
  operation: ContainedTurnOperation,
  cutoffReceiptRef: string,
  dependencies: ContainedTurnEngineDependencies,
): Promise<ContainedTurnOperation> => {
  let current = operation;
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
    if (current.dispatch.kind !== "unclaimed") {return current;}
    if (current.cancellation.kind === "requested") {return preventBeforeDispatch(current, current.cancellation.requestRef, dependencies);}
    const claim = await dependencies.operationStore.claimDispatch({
      cutoffReceiptRef,
      expectedRevision: current.revision,
      operationId: current.operationId,
    });
    if (claim.kind === "claimed") {return claim.operation;}
    if (claim.kind === "not_found") {return current;}
    current = claim.current;
  }
  throw new Error("dispatch claim CAS retry budget exhausted");
};

export const createContainedTurnEngine = (
  dependencies: ContainedTurnEngineDependencies,
): ContainedTurnFeatureApi => {
  const snapshot = Object.freeze({ ...dependencies });
  const observe = async (rawInput: ObserveContainedTurnInput): Promise<ObserveContainedTurnOutcome> => {
    const input = copyOperationRef(rawInput);
    const operation = await snapshot.operationStore.read(input.operationId);
    return operation === undefined || !hasScope(operation, input.scope)
      ? { status: "not_found" }
      : { status: "observed", turn: containedTurnView(operation) };
  };

  return Object.freeze({
    cancel: Object.freeze({
      async execute(
        rawInput: RequestContainedTurnCancellationInput,
        options?: { readonly signal?: AbortSignal },
      ): Promise<RequestContainedTurnCancellationOutcome> {
        options?.signal?.throwIfAborted();
        const input = copyOperationRef(rawInput);
        let current = await snapshot.operationStore.read(input.operationId);
        if (current === undefined || !hasScope(current, input.scope)) {return { status: "not_found" };}
        for (let attempt = 0; attempt < MAX_CAS_RETRIES && current.cancellation.kind === "open" && current.terminal.kind !== "terminal"; attempt += 1) {
          const cancelled = await snapshot.operationStore.requestCancellation({ expectedRevision: current.revision, operationId: input.operationId });
          if (cancelled.kind === "applied") {current = cancelled.operation;}
          else if (cancelled.kind === "stale" && hasScope(cancelled.current, input.scope)) {current = cancelled.current;}
          else {return { status: "not_found" };}
        }
        if (current.dispatch.kind === "unclaimed" && current.workspace.kind === "bound" && current.cancellation.kind === "requested") {
          current = await preventBeforeDispatch(current, current.cancellation.requestRef, snapshot);
        }
        return { status: "observed", turn: containedTurnView(current) };
      },
    }),
    observe: Object.freeze({ execute: observe }),
    submit: Object.freeze({
      async execute(
        rawInput: SubmitContainedTurnInput,
        options?: SubmitContainedTurnOptions,
      ): Promise<SubmitContainedTurnOutcome> {
        options?.signal?.throwIfAborted();
        const input = copyInput(rawInput);
        const manifest = snapshot.provider.manifest;
        if (manifest.providerBinding.provider !== input.expectedProvider) {return { code: "provider_mismatch", status: "unsupported" };}
        if (manifest.effectClass !== "contained_unmediated_effect") {return { code: "provider_unsupported", status: "unsupported" };}
        if (!manifest.supportedModes.includes(input.intent.mode)) {return { code: "mode_unsupported", status: "unsupported" };}
        const authorization = await snapshot.security.authorize({ intent: input.intent, provider: input.expectedProvider, scope: input.scope });
        if (authorization.kind === "denied") {return { status: "denied" };}
        const accepted = await snapshot.operationStore.accept({
          commandId: input.commandId,
          intent: input.intent,
          providerBinding: manifest.providerBinding,
          scope: input.scope,
          securityDecision: { authorityRevision: authorization.authorityRevision, decisionDigest: authorization.decisionDigest },
        });
        if (accepted.kind === "conflict") {return { code: "command_fingerprint_conflict", status: "conflict" };}
        notifyAccepted(options, accepted.operation);
        if (accepted.kind === "replayed") {return { status: "observed", turn: containedTurnView(accepted.operation) };}
        let current = accepted.operation;
        try {
          const workspace = await snapshot.workspace.create({ operationId: current.operationId, scope: current.scope });
          current = await createCas(snapshot.operationStore)(current, { kind: "workspace_bound", workspaceRef: workspace.workspaceRef });
        } catch {
          current = await createCas(snapshot.operationStore)(current, {
            evidenceRef: `workspace-create-ambiguous:${current.operationId}`,
            kind: "reconciliation_required",
          });
          return { status: "observed", turn: containedTurnView(current) };
        }
        if (current.cancellation.kind === "requested") {current = await preventBeforeDispatch(current, current.cancellation.requestRef, snapshot);}
        else {
          const guard = await snapshot.security.revalidate({
            authorityRevision: current.securityDecision.authorityRevision,
            decisionDigest: current.securityDecision.decisionDigest,
            operationId: current.operationId,
            scope: current.scope,
          });
          current = guard.kind === "prevented"
            ? await preventBeforeDispatch(current, guard.proofRef, snapshot)
            : await claimDispatch(current, guard.proofRef, snapshot);
          if (current.dispatch.kind === "claimed") {current = await completeClaimedOperation(current, snapshot);}
        }
        return { status: "observed", turn: containedTurnView(current) };
      },
    }),
  });
};
