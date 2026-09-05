type CancellationProof =
  | Readonly<{ kind: "contract_violation" }> | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "nonterminal"; status: "accepted" | "reconcile_required" | "running" }>
  | Readonly<{ kind: "operation_mismatch" }> | Readonly<{
    kind: "terminal"; status: "cancelled" | "failed" | "succeeded";
  }>;

interface CancellationOutputChunkSnapshot {
  readonly cursor: unknown;
  readonly kind: unknown;
  readonly text: unknown;
}

interface CancellationTurnSnapshot {
  readonly artifactManifestRef: unknown;
  readonly commandId: unknown;
  readonly effectId: unknown;
  readonly operationId: unknown;
  readonly output: readonly (CancellationOutputChunkSnapshot | undefined)[] | undefined;
  readonly provider: unknown;
  readonly resultRef: unknown;
  readonly revision: unknown;
  readonly status: unknown;
}

type CancellationOutcomeSnapshot =
  | Readonly<{ kind: "contract_violation" }>
  | Readonly<{ kind: "snapshot"; status: unknown; turn: CancellationTurnSnapshot | undefined }>;

const cancellationContractViolation = Object.freeze({ kind: "contract_violation" as const });
const MAX_OWNER_IDENTITY_LENGTH = 512;
const MAX_PROVIDER_IDENTITY_LENGTH = 128;
const MAX_OUTPUT_CHUNKS = 10_000;
const MAX_OUTPUT_TEXT_LENGTH = 1_000_000;

const snapshotCancellationOutput = (
  value: unknown,
): readonly (CancellationOutputChunkSnapshot | undefined)[] | undefined => {
  if (!Array.isArray(value)) {
    return;
  }
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > MAX_OUTPUT_CHUNKS) {
    return;
  }
  const output: (CancellationOutputChunkSnapshot | undefined)[] = [];
  for (let index = 0; index < length; index += 1) {
    const rawChunk: unknown = value[index];
    if (typeof rawChunk !== "object" || rawChunk === null) {
      output.push(undefined);
      continue;
    }
    const chunk = rawChunk as Readonly<Record<string, unknown>>;
    output.push(Object.freeze({ cursor: chunk.cursor, kind: chunk.kind, text: chunk.text }));
  }
  return Object.freeze(output);
};

const snapshotCancellationOutcome = (rawOutcome: unknown): CancellationOutcomeSnapshot => {
  try {
    if (typeof rawOutcome !== "object" || rawOutcome === null) {
      return cancellationContractViolation;
    }
    const outcome = rawOutcome as Readonly<Record<string, unknown>>;
    const status = outcome.status;
    const rawTurn = outcome.turn;
    let turn: CancellationTurnSnapshot | undefined;
    if (typeof rawTurn === "object" && rawTurn !== null) {
      const record = rawTurn as Readonly<Record<string, unknown>>;
      turn = Object.freeze({
        artifactManifestRef: record.artifactManifestRef,
        commandId: record.commandId,
        effectId: record.effectId,
        operationId: record.operationId,
        output: snapshotCancellationOutput(record.output),
        provider: record.provider,
        resultRef: record.resultRef,
        revision: record.revision,
        status: record.status,
      });
    }
    return Object.freeze({ kind: "snapshot" as const, status, turn });
  } catch {
    return cancellationContractViolation;
  }
};

const isBoundedOwnerIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_OWNER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/\s/u.test(value) && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const isBoundedProviderIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_IDENTITY_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- the owner identity contract excludes exact C0/C1 ranges.
  value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

type CancellationTurnStatus =
  | "accepted" | "cancelled" | "failed"
  | "reconcile_required" | "running" | "succeeded";

// oxlint-disable-next-line complexity -- terminal proof validates the complete detached owner DTO.
const validateCancellationTurn = (
  turn: CancellationTurnSnapshot,
): Readonly<{ operationId: string; status: CancellationTurnStatus }> | undefined => {
  const {
    artifactManifestRef, commandId, effectId, operationId, output, provider, resultRef, revision,
    status,
  } = turn;
  if (!isBoundedOwnerIdentity(operationId) || !isBoundedOwnerIdentity(commandId) ||
    !isBoundedOwnerIdentity(effectId) || !isBoundedProviderIdentity(provider) || output === undefined ||
    (artifactManifestRef !== undefined && !isBoundedOwnerIdentity(artifactManifestRef)) ||
    (resultRef !== undefined && !isBoundedOwnerIdentity(resultRef)) ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
    (status !== "accepted" && status !== "cancelled" && status !== "failed" &&
      status !== "reconcile_required" && status !== "running" && status !== "succeeded")) {
    return;
  }
  if ((status === "cancelled" || status === "failed" || status === "succeeded") &&
    (artifactManifestRef === undefined || resultRef === undefined)) {
    return;
  }
  let previousCursor = -1;
  for (const chunk of output) {
    const cursor = chunk?.cursor;
    const kind = chunk?.kind;
    const text = chunk?.text;
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor <= previousCursor ||
      (kind !== "assistant" && kind !== "diagnostic" && kind !== "progress") ||
      typeof text !== "string" || text.length > MAX_OUTPUT_TEXT_LENGTH || !text.isWellFormed()) {
      return;
    }
    previousCursor = cursor;
  }
  return Object.freeze({ operationId, status });
};

export const snapshotCancellationProof = (
  rawOutcome: unknown,
  expectedOperationId: string,
): CancellationProof => {
  const snapshot = snapshotCancellationOutcome(rawOutcome);
  if (snapshot.kind === "contract_violation") {
    return Object.freeze({ kind: "contract_violation" });
  }
  if (snapshot.status === "not_found") {
    return Object.freeze({ kind: "not_found" });
  }
  if (snapshot.status !== "observed" || snapshot.turn === undefined) {
    return Object.freeze({ kind: "contract_violation" });
  }
  const turn = validateCancellationTurn(snapshot.turn);
  if (turn === undefined) {
    return Object.freeze({ kind: "contract_violation" });
  }
  if (turn.operationId !== expectedOperationId) {
    return Object.freeze({ kind: "operation_mismatch" });
  }
  if (turn.status === "cancelled" || turn.status === "failed" || turn.status === "succeeded") {
    return Object.freeze({ kind: "terminal", status: turn.status });
  }
  return Object.freeze({ kind: "nonterminal", status: turn.status });
};
