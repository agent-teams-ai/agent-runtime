import type { ContainedTurnIntent } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";
import type { ContainedTurnKernelOperation } from "../domain/contained-turn-kernel-model.js";

export const containedTurnAcceptanceIntentDigestV1 = (intent: ContainedTurnIntent) =>
  digestContainedTurnCanonicalValue({
    purpose: "contained_turn_acceptance_intent_v1",
    intent: { mode: intent.mode, prompt: intent.prompt },
    version: 1,
  });

/** V1 preserves the established dispatch constraints preimage byte for byte. */
export const containedTurnAcceptanceConstraintsDigestV1 = (
  facts: Pick<ContainedTurnKernelOperation, "adapterSnapshot" | "capabilityManifest" | "intent">,
) => digestContainedTurnCanonicalValue({
  adapterSnapshot: facts.adapterSnapshot,
  capabilityManifest: facts.capabilityManifest,
  intentMode: facts.intent.mode,
} as never);
