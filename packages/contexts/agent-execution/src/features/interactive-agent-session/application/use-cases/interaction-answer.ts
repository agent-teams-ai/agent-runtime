import type {InteractionReply} from "../ports/outbound/interactive-provider-driver.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Reflect.ownKeys(value).some(key => typeof key !== "string");
const fields = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length
  && expected.every(key => Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!);

/** Validate and detach untrusted JS before any durable decision intent or callback grant. */
export function interactionAnswer(value: unknown): InteractionReply | undefined {
  if (!object(value) || !Object.getOwnPropertyDescriptor(value, "kind") || !("value" in Object.getOwnPropertyDescriptor(value, "kind")!)) {return;}
  if (value.kind === "permission" && fields(value, ["kind", "decision"]) && ["allow", "deny"].includes(value.decision as string)) {
    return {kind: "permission", decision: value.decision as "allow" | "deny"};
  }
  if (value.kind !== "question" || !fields(value, ["kind", "answers"]) || !object(value.answers)) {return;}
  const answers = value.answers;
  if (Object.keys(answers).some(key => {const property = Object.getOwnPropertyDescriptor(answers, key); return !property || !("value" in property) || typeof property.value !== "string";})) {return;}
  return {kind: "question", answers: Object.fromEntries(Object.keys(answers).toSorted().map(key => [key, answers[key] as string]))};
}
export function answerFingerprint(interactionId: string, answer: InteractionReply): string {
  return JSON.stringify(["reply", interactionId, answer.kind,
    answer.kind === "permission" ? answer.decision : Object.entries(answer.answers).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)]);
}
