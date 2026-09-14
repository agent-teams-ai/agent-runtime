import type { ContainedTurnIntent } from "../domain/contained-turn-authority.js";
import { digestContainedTurnCanonicalValue } from "../domain/contained-turn-codecs.js";

export const containedTurnAcceptanceIntentDigestV1 = (intent: ContainedTurnIntent) =>
  digestContainedTurnCanonicalValue({
    purpose: "contained_turn_acceptance_intent_v1",
    intent: { mode: intent.mode, prompt: intent.prompt },
    version: 1,
  });

export { containedTurnAcceptanceConstraintsDigestV1 } from "../domain/contained-turn-dispatch-authority.js";
