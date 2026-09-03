import type { ContainedTurnKernelOperation } from "./contained-turn-kernel-model.js";
import {
  CONTAINED_TURN_LIMITS,
  utf8ByteLength,
  validateContainedTurnText,
} from "./contained-turn-limits.js";
import { requireContainedTurnProof } from "./contained-turn-proof-validation.js";
import { assertContainedTurnExactRecord } from "./contained-turn-record.js";
import { containedTurnInvariant as invariant } from "./contained-turn-invariant.js";

/**
 * Validates the provider output stream independently from lifecycle state.
 * Keeping this orthogonal check in its own domain module keeps the aggregate
 * validation boundary below the repository's per-file maintainability limit.
 */
export const validateContainedTurnOutput = (operation: ContainedTurnKernelOperation): void => {
  invariant(
    operation.output.chunks.length <= CONTAINED_TURN_LIMITS.collections.outputChunks,
    "output chunk limit exceeded",
  );

  let totalBytes = 0;
  operation.output.chunks.forEach((chunk, index) => {
    assertContainedTurnExactRecord("output chunk", chunk, ["cursor", "kind", "text"]);
    invariant(chunk.cursor === index, "output cursors must be contiguous from zero");
    invariant(
      chunk.kind === "assistant" || chunk.kind === "diagnostic" || chunk.kind === "progress",
      "unknown output kind fails closed",
    );
    validateContainedTurnText("output chunk", chunk.text, CONTAINED_TURN_LIMITS.text.outputChunk);
    totalBytes += utf8ByteLength(chunk.text);
  });

  invariant(totalBytes <= CONTAINED_TURN_LIMITS.text.outputTotal.maximumBytes, "output total byte limit exceeded");
  if (operation.output.fence.kind !== "fenced") {
    return;
  }

  invariant(
    operation.output.fence.finalCursor === operation.output.chunks.length,
    "output final cursor must equal the contiguous next cursor",
  );
  if (operation.output.fence.proofId !== undefined) {
    requireContainedTurnProof(
      operation,
      operation.output.fence.proofId,
      operation.dispatch.kind === "prevented" || operation.providerProcessStart.kind === "proved_no_start"
        ? "output_no_start_drain"
        : "output_drain",
    );
  }
};
