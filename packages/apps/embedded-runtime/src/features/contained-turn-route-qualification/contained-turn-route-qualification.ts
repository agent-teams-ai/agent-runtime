import { readFileSync } from "node:fs";
import {
  CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS,
  type ContainedTurnRouteQualificationTarget,
} from "@agent-teams/agent-execution/composition";

/**
 * The repository's own governance registry. Promotion into it is an explicit
 * evidence-and-readiness act, which is exactly why the product route gate reads
 * it instead of trusting a caller flag. A missing, unreadable or differently
 * governed registry qualifies nothing.
 */
export const PRODUCT_QUALIFICATION_REGISTRY = new URL(
  "../../../../../../docs/architecture/qualification-registry.json", import.meta.url,
);
export type ContainedTurnProductQualificationRegistry = typeof PRODUCT_QUALIFICATION_REGISTRY;

/** Only these two levels are enforced-route qualification; "scoped" is not. */
const QUALIFIED_LEVELS = Object.freeze(["implementation", "deployment"]);

/** The matching policy this gate depends on. A registry that relaxed exact
 * whole-tuple matching, allowed wildcards, or defaulted to anything other than
 * unqualified would make a match meaningless, so it qualifies nothing. */
const REQUIRED_MATCHING_POLICY = Object.freeze({
  default: "unqualified",
  dimensionRule: "exact-match-whole-target-tuple",
  entryValueRule: "each-target-is-one-complete-observed-scalar-tuple",
  promotionRule: "explicit-evidence-and-readiness-update",
  wildcardsAllowed: false,
});

type JsonRecord = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;

const matchesGovernedPolicy = (registry: JsonRecord): boolean => {
  const policy = asRecord(registry.matchingPolicy);
  if (policy === undefined) {return false;}
  for (const [key, expected] of Object.entries(REQUIRED_MATCHING_POLICY)) {
    if (policy[key] !== expected) {return false;}
  }
  return true;
};

const isExactTuple = (candidate: unknown, target: ContainedTurnRouteQualificationTarget): boolean => {
  const tuple = asRecord(candidate);
  if (tuple === undefined ||
      Object.keys(tuple).length !== CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS.length) {
    return false;
  }
  for (const dimension of CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS) {
    if (tuple[dimension] !== target[dimension]) {return false;}
  }
  return true;
};

/**
 * True only when the registry promotes this exact whole tuple to at least
 * "implementation" with evidence attached. Every read failure, schema drift or
 * partial match is a refusal, never a pass: the caller of this predicate is a
 * fail-closed gate and treats a thrown error the same way.
 */
export const registryQualifiesRouteTarget = (
  registry: URL, target: ContainedTurnRouteQualificationTarget,
): boolean => {
  const parsed = asRecord(JSON.parse(readFileSync(registry, "utf8")) as unknown);
  if (parsed === undefined || !matchesGovernedPolicy(parsed) || !Array.isArray(parsed.entries)) {
    return false;
  }
  for (const value of parsed.entries) {
    const entry = asRecord(value);
    if (entry === undefined || typeof entry.qualification !== "string" ||
        !QUALIFIED_LEVELS.includes(entry.qualification) ||
        !Array.isArray(entry.evidence) || entry.evidence.length === 0 ||
        !Array.isArray(entry.targets)) {
      continue;
    }
    if (entry.targets.some(candidate => isExactTuple(candidate, target))) {return true;}
  }
  return false;
};
