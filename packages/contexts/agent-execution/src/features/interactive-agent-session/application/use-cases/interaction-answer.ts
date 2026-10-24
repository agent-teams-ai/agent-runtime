import type {InteractionReply} from "../ports/outbound/interactive-provider-driver.js";

/** Snapshot plain own data once; never re-read caller getters or Proxy get traps. */
function dataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object") {return;}
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {return;}
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(properties).some(key => typeof key !== "string")) {return;}
    const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, property] of Object.entries(properties)) {
      if (property.enumerable !== true || !("value" in property)) {return;}
      detached[key] = property.value;
    }
    return detached;
  } catch {return;}
}

/** Validate and detach untrusted JS before any durable decision intent or callback grant. */
export function interactionAnswer(value: unknown): InteractionReply | undefined {
  const data = dataRecord(value);
  if (!data || Object.keys(data).length !== 2) {return;}
  if (data.kind === "permission" && (data.decision === "allow" || data.decision === "deny")) {
    return {kind: "permission", decision: data.decision};
  }
  if (data.kind !== "question") {return;}
  if (data.decision === "deny") {return {kind: "question", decision: "deny"};}
  const answers = dataRecord(data.answers); if (!answers) {return;}
  if (Object.values(answers).some(answer => typeof answer !== "string")) {return;}
  return {kind: "question", answers: Object.fromEntries(Object.keys(answers).toSorted().map(key => [key, answers[key] as string]))};
}
export function answerFingerprint(interactionId: string, answer: InteractionReply): string {
  return JSON.stringify(["reply", interactionId, answer.kind,
    answer.kind === "permission" || answer.decision === "deny" ? answer.decision : Object.entries(answer.answers).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]);
}
