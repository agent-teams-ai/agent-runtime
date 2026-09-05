import { isContainedTurnAccessAuthorityIdentity } from "./contained-turn-access-authority.js";
import type {
  ObserveRuntimeContainedTurnOutcome,
  RuntimeContainedTurnView,
  SubmitRuntimeContainedTurnInput,
  SubmitRuntimeContainedTurnOutcome,
} from "../contracts/runtime-access.js";
import { ContainedTurnOwnerContractError } from "./contained-turn-owner-contract-error.js";
import type { ContainedTurnCompositionOperationRef } from "./contained-turn-operation-ref.js";
import type {
  OwnerTurnObservation,
} from "./contained-turn-composition-types.js";
import type { ContainedTurnCompositionScope } from "./trusted-runtime-access-scope.js";

export const unavailableOutcome = Object.freeze({
  code: "capability_unavailable" as const,
  status: "unsupported" as const,
});

export const providerUnsupportedOutcome = Object.freeze({
  code: "provider_unsupported" as const,
  status: "unsupported" as const,
});

const MAX_PROVIDER_IDENTITY_LENGTH = 128;
const MAX_COMMAND_ID_LENGTH = 256;
const MAX_PROMPT_BYTES = 65_536;
const MAX_OWNER_IDENTITY_LENGTH = 512;
const MAX_OUTPUT_CHUNKS = 10_000;
const MAX_OUTPUT_TEXT_LENGTH = 1_000_000;

export const isBoundedIdentity = (value: unknown): value is string =>
  typeof value === "string" && !isContainedTurnAccessAuthorityIdentity(value) && value.length > 0 && value.length <= MAX_OWNER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/\s/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const isTurnStatus = (value: unknown): value is OwnerTurnObservation["status"] =>
  value === "accepted" || value === "cancelled" || value === "failed" ||
  value === "reconcile_required" || value === "running" || value === "succeeded";

export const contractViolation = (
  code: ConstructorParameters<typeof ContainedTurnOwnerContractError>[0],
): never => {throw new ContainedTurnOwnerContractError(code);};

const copyProviderIdentity = (value: unknown): string | undefined =>
  typeof value === "string" && !isContainedTurnAccessAuthorityIdentity(value) && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH &&
    // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
    value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : undefined;

const copyCommandId = (value: unknown): string | undefined =>
  typeof value === "string" && !isContainedTurnAccessAuthorityIdentity(value) && value.length > 0 && value.length <= MAX_COMMAND_ID_LENGTH &&
    /^[\x20-\x7E]+$/u.test(value) && value.isWellFormed() &&
    !value.includes("\u0000")
    ? value
    : undefined;

const copyPrompt = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.isWellFormed() &&
    new TextEncoder().encode(value).byteLength <= MAX_PROMPT_BYTES &&
    !value.includes("\u0000")
    ? value
    : undefined;

interface OwnerOutputChunkSnapshot {
  readonly cursor: unknown;
  readonly kind: unknown;
  readonly text: unknown;
}

interface OwnerTurnSnapshot {
  readonly artifactManifestRef: unknown;
  readonly commandId: unknown;
  readonly effectId: unknown;
  readonly operationId: unknown;
  readonly output: readonly (OwnerOutputChunkSnapshot | undefined)[] | undefined;
  readonly provider: unknown;
  readonly resultRef: unknown;
  readonly revision: unknown;
  readonly status: unknown;
}

type OwnerSnapshot<T> =
  | Readonly<{ kind: "contract_violation" }>
  | Readonly<{ kind: "snapshot"; value: T }>;

const ownerContractViolation = Object.freeze({ kind: "contract_violation" as const });

const snapshotOwnerOutput = (
  value: unknown,
): readonly (OwnerOutputChunkSnapshot | undefined)[] | undefined => {
  if (!Array.isArray(value)) {
    return;
  }
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > MAX_OUTPUT_CHUNKS) {
    return;
  }
  const output: (OwnerOutputChunkSnapshot | undefined)[] = [];
  for (let index = 0; index < length; index += 1) {
    const rawChunk: unknown = value[index];
    if (typeof rawChunk !== "object" || rawChunk === null) {
      output.push(undefined);
      continue;
    }
    const chunk = rawChunk as Readonly<Record<string, unknown>>;
    const cursor = chunk.cursor;
    const kind = chunk.kind;
    const text = chunk.text;
    output.push(Object.freeze({ cursor, kind, text }));
  }
  return Object.freeze(output);
};

const snapshotOwnerTurn = (
  value: unknown,
  onOperationId?: (operationId: unknown) => void,
): OwnerTurnSnapshot | undefined => {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const turn = value as Readonly<Record<string, unknown>>;
  const operationId = turn.operationId;
  onOperationId?.(operationId);
  return Object.freeze({
    artifactManifestRef: turn.artifactManifestRef,
    commandId: turn.commandId,
    effectId: turn.effectId,
    operationId,
    output: snapshotOwnerOutput(turn.output),
    provider: turn.provider,
    resultRef: turn.resultRef,
    revision: turn.revision,
    status: turn.status,
  });
};

interface OwnerObservationOutcomeSnapshot {
  readonly status: unknown;
  readonly turn: OwnerTurnSnapshot | undefined;
}

const snapshotOwnerObservationOutcome = (
  outcome: unknown,
): OwnerSnapshot<OwnerObservationOutcomeSnapshot> => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return ownerContractViolation;
    }
    const record = outcome as Readonly<Record<string, unknown>>;
    const status = record.status;
    const rawTurn = record.turn;
    return Object.freeze({
      kind: "snapshot" as const,
      value: Object.freeze({ status, turn: snapshotOwnerTurn(rawTurn) }),
    });
  } catch {
    return ownerContractViolation;
  }
};

export const isTerminalTurnStatus = (status: OwnerTurnObservation["status"]): boolean =>
  status === "cancelled" || status === "failed" || status === "succeeded";

// oxlint-disable-next-line complexity -- this anti-corruption boundary validates every detached DTO field.
const mapContainedTurnView = (
  turn: OwnerTurnSnapshot,
  expectedOperationId?: string,
): RuntimeContainedTurnView | undefined => {
  const {
    artifactManifestRef, commandId, effectId, operationId, output: ownerOutput,
    provider: ownerProvider, resultRef, revision, status,
  } = turn;
  if (!isBoundedIdentity(operationId)) {
    return contractViolation("invalid_operation_id");
  }
  if (!isBoundedIdentity(commandId) || !isBoundedIdentity(effectId)) {
    return;
  }
  if (expectedOperationId !== undefined && operationId !== expectedOperationId) {
    return contractViolation("operation_id_mismatch");
  }
  const provider = copyProviderIdentity(ownerProvider);
  if (provider === undefined || !isTurnStatus(status) || ownerOutput === undefined ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return;
  }
  if ((artifactManifestRef !== undefined && !isBoundedIdentity(artifactManifestRef)) ||
    (resultRef !== undefined && !isBoundedIdentity(resultRef))) {
    return;
  }
  if (isTerminalTurnStatus(status) &&
    (artifactManifestRef === undefined || resultRef === undefined)) {
    return;
  }
  const output: RuntimeContainedTurnView["output"][number][] = [];
  let previousCursor = -1;
  for (const chunk of ownerOutput) {
    const cursor = chunk?.cursor;
    const kind = chunk?.kind;
    const text = chunk?.text;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= previousCursor ||
      (kind !== "assistant" && kind !== "diagnostic" && kind !== "progress") ||
      typeof text !== "string" || text.length > MAX_OUTPUT_TEXT_LENGTH || !text.isWellFormed()) {
      return;
    }
    previousCursor = cursor;
    output.push(Object.freeze({ cursor, kind, text }));
  }
  return Object.freeze({
    ...(artifactManifestRef === undefined ? {} : { artifactManifestRef }),
    commandId,
    effectId,
    operationId,
    output: Object.freeze(output),
    provider,
    ...(resultRef === undefined ? {} : { resultRef }),
    status,
  });
};

export const copyObservation = (
  outcome: unknown,
  expectedOperationId: string,
): ObserveRuntimeContainedTurnOutcome => {
  const snapshot = snapshotOwnerObservationOutcome(outcome);
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  if (snapshot.value.status === "not_found") {
    return Object.freeze({ status: "not_found" as const });
  }
  if (snapshot.value.status !== "observed" || snapshot.value.turn === undefined) {
    return contractViolation("malformed_owner_outcome");
  }
  const turn = mapContainedTurnView(snapshot.value.turn, expectedOperationId);
  return turn === undefined
    ? unavailableOutcome
    : Object.freeze({ status: "observed" as const, turn });
};

export const copyInput = (
  input: SubmitRuntimeContainedTurnInput,
): SubmitRuntimeContainedTurnInput | undefined => {
  try {
    const commandId = copyCommandId(input.commandId);
    const expectedProvider = copyProviderIdentity(input.expectedProvider);
    const intent = input.intent;
    const prompt = copyPrompt(intent.prompt);
    if (commandId === undefined || expectedProvider === undefined || prompt === undefined ||
      (intent.mode !== "analysis" && intent.mode !== "workspace-write")) {
      return;
    }
    return Object.freeze({
      commandId,
      expectedProvider,
      intent: Object.freeze({ mode: intent.mode, prompt }),
    });
  } catch {
    return;
  }
};

export const copyAcceptedOperation = (
  operation: ContainedTurnCompositionOperationRef,
  boundScope: ContainedTurnCompositionScope,
  onOperationId?: (operationId: unknown) => void,
): ContainedTurnCompositionOperationRef => {
  let snapshot: OwnerSnapshot<Readonly<{
    operationId: unknown;
    projectId: unknown;
    tenantId: unknown;
  }>>;
  try {
    const operationId = operation.operationId;
    onOperationId?.(operationId);
    const rawScope = operation.scope;
    if (typeof rawScope !== "object" || rawScope === null) {
      return contractViolation("malformed_owner_outcome");
    }
    const scope = rawScope as unknown as Readonly<Record<string, unknown>>;
    snapshot = Object.freeze({
      kind: "snapshot",
      value: Object.freeze({
        operationId,
        projectId: scope.projectId,
        tenantId: scope.tenantId,
      }),
    });
  } catch {
    snapshot = ownerContractViolation;
  }
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  if (!isBoundedIdentity(snapshot.value.operationId)) {
    return contractViolation("invalid_operation_id");
  }
  if (snapshot.value.projectId !== boundScope.projectId ||
    snapshot.value.tenantId !== boundScope.tenantId) {
    return contractViolation("malformed_owner_outcome");
  }
  return Object.freeze({
    operationId: snapshot.value.operationId,
    scope: Object.freeze({ ...boundScope }),
  });
};

export interface CopiedSubmitOutcome {
  readonly observation?: Readonly<{
    operationId: string;
    status: OwnerTurnObservation["status"];
  }>;
  readonly outcome: SubmitRuntimeContainedTurnOutcome;
}

interface OwnerSubmitOutcomeSnapshot {
  readonly candidateOperationId: unknown;
  readonly commandId: unknown;
  readonly evidenceId: unknown;
  readonly code: unknown;
  readonly status: unknown;
  readonly turn: OwnerTurnSnapshot | undefined;
}

const snapshotOwnerSubmitOutcome = (
  outcome: unknown,
  onOperationId?: (operationId: unknown) => void,
): OwnerSnapshot<OwnerSubmitOutcomeSnapshot> => {
  try {
    if (typeof outcome !== "object" || outcome === null) {
      return ownerContractViolation;
    }
    const record = outcome as Readonly<Record<string, unknown>>;
    const rawTurn = record.turn;
    const turn = snapshotOwnerTurn(rawTurn, onOperationId);
    const status = record.status;
    const code = record.code;
    return Object.freeze({
      kind: "snapshot" as const,
      value: Object.freeze({
        candidateOperationId: record.candidateOperationId,
        commandId: record.commandId,
        evidenceId: record.evidenceId,
        code, status, turn,
      }),
    });
  } catch {
    return ownerContractViolation;
  }
};

export const copySubmitOutcome = (
  outcome: unknown,
  onOperationId?: (operationId: unknown) => void,
): CopiedSubmitOutcome => {
  const snapshot = snapshotOwnerSubmitOutcome(outcome, onOperationId);
  if (snapshot.kind === "contract_violation") {
    return contractViolation("malformed_owner_outcome");
  }
  const { candidateOperationId, commandId, evidenceId, code, status, turn } = snapshot.value;
  if (status === "potential_acceptance") {
    const copiedCommandId = copyCommandId(commandId);
    if (turn !== undefined || !isBoundedIdentity(candidateOperationId) ||
      copiedCommandId === undefined || !isBoundedIdentity(evidenceId)) {
      return contractViolation("malformed_owner_outcome");
    }
    return Object.freeze({ outcome: Object.freeze({
      candidateOperationId, commandId: copiedCommandId, evidenceId,
      status: "potential_acceptance" as const,
    }) });
  }
  if (status === "observed") {
    if (turn === undefined) {
      return contractViolation("malformed_owner_outcome");
    }
    const observation = mapContainedTurnView(turn);
    if (observation === undefined) {
      return contractViolation("malformed_owner_outcome");
    }
    return Object.freeze({
      observation,
      outcome: Object.freeze({ operationId: observation.operationId, status: "accepted" as const }),
    });
  }
  if (status === "denied") {
    return Object.freeze({ outcome: Object.freeze({ status: "denied" as const }) });
  }
  if (status === "conflict" && code === "command_fingerprint_conflict") {
    return Object.freeze({ outcome: Object.freeze({ code, status: "conflict" as const }) });
  }
  if (status === "unsupported" && (code === "mode_unsupported" ||
    code === "provider_mismatch" || code === "provider_unsupported")) {
    return Object.freeze({ outcome: Object.freeze({ code, status: "unsupported" as const }) });
  }
  return contractViolation("malformed_owner_outcome");
};
