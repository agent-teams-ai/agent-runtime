import { createHash } from "node:crypto";

import { z } from "zod";

import { CONTAINED_TURN_REQUIRED_RECEIPTS, type ContainedTurnOperation } from "../../../domain/contained-turn-operation.js";

const MAX_REFERENCE_LENGTH = 4_096;
const boundedReference = z.string().min(1).max(MAX_REFERENCE_LENGTH).refine(value => !value.includes("\u0000"));
const kind = <Values extends readonly [string, ...string[]]>(values: Values) => z.enum(values);

const receiptSchema = z.object({
  kind: kind(CONTAINED_TURN_REQUIRED_RECEIPTS),
  receiptRef: boundedReference,
}).strict();

const operationSchema = z.object({
  artifact: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open") }).strict(),
    z.object({ kind: z.literal("sealed"), manifestRef: boundedReference }).strict(),
  ]),
  cancellation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open") }).strict(),
    z.object({ kind: z.literal("requested"), requestRef: boundedReference }).strict(),
  ]),
  commandFingerprint: z.string().regex(/^[a-f\d]{64}$/u),
  commandId: boundedReference,
  containment: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_required") }).strict(),
    z.object({ kind: z.literal("pending") }).strict(),
    z.object({ kind: z.literal("contained"), receiptRef: boundedReference }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("unproven") }).strict(),
  ]),
  cutoff: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pending") }).strict(),
    z.object({
      disposition: z.enum(["enforced", "not_applicable"]),
      kind: z.literal("closed"),
      receiptRef: boundedReference,
    }).strict(),
  ]),
  dispatch: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unclaimed") }).strict(),
    z.object({ attemptId: boundedReference, claimRef: boundedReference, kind: z.literal("claimed") }).strict(),
    z.object({ kind: z.literal("prevented"), receiptRef: boundedReference }).strict(),
  ]),
  effect: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unresolved") }).strict(),
    z.object({
      disposition: z.enum(["committed", "not_committed"]),
      kind: z.literal("resolved"),
      receiptRef: boundedReference,
    }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("ambiguous") }).strict(),
  ]),
  effectId: boundedReference,
  execution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not_started") }).strict(),
    z.object({ kind: z.literal("running") }).strict(),
    z.object({
      kind: z.literal("closed"),
      outcome: z.enum(["cancelled", "failed", "succeeded"]),
      receiptRef: boundedReference,
    }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("unknown") }).strict(),
  ]),
  intent: z.object({
    mode: z.enum(["analysis", "workspace-write"]),
    prompt: z.string().min(1).max(65_536).refine(value => !value.includes("\u0000")),
  }).strict(),
  operationId: boundedReference,
  output: z.object({
    chunks: z.array(z.object({
      cursor: z.number().int().nonnegative(),
      kind: z.enum(["assistant", "diagnostic", "progress"]),
      text: z.string().max(2_000_000),
    }).strict()).max(2_048),
    kind: z.enum(["open", "sealed"]),
    nextCursor: z.number().int().nonnegative().max(2_048),
    sealReceiptRef: boundedReference.optional(),
  }).strict(),
  providerAcceptance: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unobserved") }).strict(),
    z.object({ kind: z.literal("accepted"), receiptRef: boundedReference }).strict(),
    z.object({ kind: z.literal("not_accepted"), receiptRef: boundedReference }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("unknown") }).strict(),
  ]),
  providerBinding: z.object({
    adapterRevision: boundedReference,
    binaryRevision: boundedReference,
    capabilityManifestRevision: boundedReference,
    credentialBindingDigest: boundedReference,
    provider: z.enum(["claude", "codex"]),
    providerRouteRef: boundedReference,
  }).strict(),
  receipts: z.array(receiptSchema).max(CONTAINED_TURN_REQUIRED_RECEIPTS.length),
  reconciliation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("required") }).strict(),
  ]),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unpublished") }).strict(),
    z.object({ kind: z.literal("published"), resultRef: boundedReference }).strict(),
  ]),
  revision: z.number().int().nonnegative(),
  scope: z.object({ projectId: boundedReference, tenantId: boundedReference }).strict(),
  securityDecision: z.object({ authorityRevision: boundedReference, decisionDigest: boundedReference }).strict(),
  terminal: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("nonterminal") }).strict(),
    z.object({
      kind: z.literal("terminal"),
      outcome: z.enum(["cancelled", "failed", "succeeded"]),
      receiptRef: boundedReference,
    }).strict(),
  ]),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unbound") }).strict(),
    z.object({ kind: z.literal("bound"), workspaceRef: boundedReference }).strict(),
    z.object({ kind: z.literal("closed"), receiptRef: boundedReference, workspaceRef: boundedReference }).strict(),
    z.object({ evidenceRef: boundedReference, kind: z.literal("quarantined"), workspaceRef: boundedReference }).strict(),
  ]),
}).strict();

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {return JSON.stringify(value);}
  if (Array.isArray(value)) {return `[${value.map(candidate => canonicalJson(candidate)).join(",")}]`;}
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).toSorted().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {deepFreeze(nested);}
    Object.freeze(value);
  }
  return value;
};

export const encodeContainedTurnState = (operation: ContainedTurnOperation): {
  readonly digest: string;
  readonly json: string;
} => {
  const json = canonicalJson(operation);
  return Object.freeze({ digest: createHash("sha256").update(json).digest("hex"), json });
};

export const decodeContainedTurnState = (state: unknown, expectedDigest: string): ContainedTurnOperation => {
  const parsed = operationSchema.parse(state);
  const digest = createHash("sha256").update(canonicalJson(parsed)).digest("hex");
  if (digest !== expectedDigest) {throw new Error("contained turn state digest mismatch");}
  return deepFreeze(parsed) as ContainedTurnOperation;
};
