import { createDockerLinuxExclusiveRouteAdmission,
  type DockerLinuxExclusiveRouteAdmissionInput } from "./docker-linux-exclusive-route-admission.js";
import type { DockerLinuxOperationRouteAdmission } from "./docker-linux-post-claim-preparation.js";

/** The eight qualification-registry target dimensions, in registry order. */
export const CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS = Object.freeze([
  "provider", "providerAdapter", "binaryClosure", "platform", "credentialRoute",
  "storageTopology", "transportTopology", "failureDomain",
] as const);

type Dimension = (typeof CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS)[number];

/** One complete observed scalar tuple, in the registry's own dimension vocabulary. */
export type ContainedTurnRouteQualificationTarget = Readonly<Record<Dimension, string>>;

/**
 * Nominal route-enforcement capability. It is not a structural record: only
 * this module's factory can produce a value that
 * `readContainedTurnRouteEnforcementTarget` resolves, because membership is
 * kept in a module-private WeakMap rather than in a property a caller could
 * copy, spread, or proxy. A structural twin therefore carries no target at all,
 * and reading the target never touches a property of the candidate value.
 */
export interface ContainedTurnRouteEnforcementCapability {
  /** The route admission the post-claim preparation installs and releases. */
  readonly admission: DockerLinuxOperationRouteAdmission;
}

export type ContainedTurnRouteEnforcementInput = DockerLinuxExclusiveRouteAdmissionInput & Readonly<{
  /** The exact tuple that governance must have promoted for this route. Three
   * of its dimensions are bound below to the route binding this owner enforces;
   * the remaining five are trusted deployment facts, exactly like the tool pins. */
  qualificationTarget: ContainedTurnRouteQualificationTarget;
}>;

const minted = new WeakMap<object, ContainedTurnRouteQualificationTarget>();
// The registry forbids these tokens outright; a capability may not carry one.
const WILDCARD_TOKENS = Object.freeze(["*", "any", "all"]);
const invalidTarget = (): TypeError =>
  new TypeError("Contained turn route qualification target is invalid");

const snapshotTarget = (value: unknown): ContainedTurnRouteQualificationTarget => {
  if (value === null || typeof value !== "object") {throw invalidTarget();}
  // One descriptor pass, then a frozen copy: a re-reading source cannot show
  // this gate one tuple and the route owner another.
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS.length) {
    throw invalidTarget();
  }
  const snapshot: Record<string, string> = {};
  for (const dimension of CONTAINED_TURN_ROUTE_QUALIFICATION_DIMENSIONS) {
    const field = fields[dimension];
    if (field === undefined || !("value" in field)) {throw invalidTarget();}
    const token: unknown = field.value;
    if (typeof token !== "string" || token.length < 1 || token.length > 256 ||
        /[\p{Cc}\s]/u.test(token) || WILDCARD_TOKENS.includes(token.toLowerCase())) {
      throw invalidTarget();
    }
    snapshot[dimension] = token;
  }
  return Object.freeze(snapshot) as ContainedTurnRouteQualificationTarget;
};

/**
 * The only producer of a route-enforcement capability. It opens no route by
 * itself: it constructs the Linux exclusive route admission, which still has to
 * satisfy Linux/x64/root and the exact tool pins before any kernel effect, and
 * binds the promoted target tuple to that admission's own route binding. The
 * declared `providerAdapter` and `binaryClosure` must be the adapter and binary
 * revisions the route owner enforces, so a promoted tuple cannot be re-used for
 * a different provider closure.
 */
export const createContainedTurnRouteEnforcement = (
  input: ContainedTurnRouteEnforcementInput,
): ContainedTurnRouteEnforcementCapability => {
  const target = snapshotTarget(input.qualificationTarget);
  const binding = input.binding;
  if (target.binaryClosure !== binding.binaryRevision ||
      target.providerAdapter !== binding.adapterRevision) {
    throw invalidTarget();
  }
  const capability = Object.freeze({admission: createDockerLinuxExclusiveRouteAdmission(input)});
  minted.set(capability, target);
  return capability;
};

/**
 * Resolves the promoted target of an authentic capability. Any other value —
 * absent, primitive, structural twin, or a Proxy wrapping a genuine capability
 * — resolves to `undefined` without a single property access on it.
 */
export const readContainedTurnRouteEnforcementTarget = (
  value: unknown,
): ContainedTurnRouteQualificationTarget | undefined =>
  value !== null && typeof value === "object" ? minted.get(value) : undefined;
