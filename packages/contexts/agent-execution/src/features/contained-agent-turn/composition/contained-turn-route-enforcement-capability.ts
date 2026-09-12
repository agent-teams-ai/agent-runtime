import {readDarwinCodexRouteEnforcementTarget} from "./darwin-codex-route-enforcement.js";
import {nodeDockerRoutePolicy, selectNodeDockerRoute} from "./node-docker-route-provenance.js";
import type {DockerLinuxOperationRouteAdmission, DockerLinuxPostClaimDependencies} from "./docker-linux-post-claim-preparation.js";
import {custodyDataRecord} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import { createDockerLinuxExclusiveRouteAdmission,
  type DockerLinuxExclusiveRouteAdmissionInput } from "./docker-linux-exclusive-route-admission.js";

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
  /** Immutable deployment policy required for joining a concrete Node recipe. */
  enginePolicy?: DockerLinuxPostClaimDependencies["enginePolicy"];
}>;

type Binding = DockerLinuxExclusiveRouteAdmissionInput["binding"];
type Owner = Readonly<{policy: string | undefined; target: ContainedTurnRouteQualificationTarget; route: DockerLinuxExclusiveRouteAdmissionInput}>;
const minted = new WeakMap<object, Owner>();
const selectedAdmissions = new WeakMap<object, DockerLinuxOperationRouteAdmission>();
// These facts belong to each committed operation, not to deployment qualification.
const operationFields = new Set<keyof Binding>([
  "operationId", "attemptId", "custodyId", "executionGenerationId", "authorityVectorDigest",
]);
const snapshotBinding = (binding: Binding): Binding => {
  try {return Object.freeze({...custodyDataRecord(binding)});} catch {throw invalidTarget();}
};
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
 * The Linux producer of a route-enforcement capability. It opens no route by
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
  const binding = snapshotBinding(input.binding);
  if (target.binaryClosure !== binding.binaryRevision ||
      target.providerAdapter !== binding.adapterRevision) {
    throw invalidTarget();
  }
  const route = Object.freeze({binding, engine: Object.freeze({inspect: input.engine.inspect.bind(input.engine)}),
    nsenter: Object.freeze({...input.nsenter}), nft: Object.freeze({...input.nft})});
  const capability = Object.freeze({admission: createDockerLinuxExclusiveRouteAdmission(route)});
  minted.set(capability, Object.freeze({target, route,
    policy: input.enginePolicy === undefined ? undefined : nodeDockerRoutePolicy(input.enginePolicy)}));
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
  value !== null && typeof value === "object" ? minted.get(value)?.target ?? readDarwinCodexRouteEnforcementTarget(value) : undefined;

type Recipe = Parameters<typeof selectNodeDockerRoute>[0];

/** Bind a fresh operation to the original nominal deployment owner. No target or
 * replacement engine/tools are accepted here. An exact issued Node recipe may
 * supply its operation inspector after policy, pins and subject are joined.
 * When a recipe is supplied, preparation is the immutable snapshot checked by
 * provenance and must be used for execution. The capability gains no fields.
 * PA, Host and closure facts must match that owner; only operation identities may change. This allocates no route.
 */
export function bindContainedTurnRouteEnforcement<P extends Recipe["preparation"]>(
  capability: ContainedTurnRouteEnforcementCapability, bindingInput: Binding,
  recipe: Readonly<{route: Recipe["route"]; preparation: P}>,
): DockerLinuxExclusiveRouteAdmissionInput & Readonly<{preparation: P}>;
export function bindContainedTurnRouteEnforcement(
  capability: ContainedTurnRouteEnforcementCapability, bindingInput: Binding,
  recipe?: Recipe,
): DockerLinuxExclusiveRouteAdmissionInput;
export function bindContainedTurnRouteEnforcement(
  capability: ContainedTurnRouteEnforcementCapability, bindingInput: Binding,
  recipe?: Parameters<typeof selectNodeDockerRoute>[0],
): DockerLinuxExclusiveRouteAdmissionInput {
  const owner = minted.get(capability);
  if (owner === undefined) {throw invalidTarget();}
  const binding = snapshotBinding(bindingInput);
  const keys = Reflect.ownKeys(owner.route.binding) as (keyof Binding)[];
  if (Reflect.ownKeys(binding).length !== keys.length || keys.some(key =>
    !Object.hasOwn(binding, key) || (!operationFields.has(key) && binding[key] !== owner.route.binding[key]))) {
    throw invalidTarget();
  }
  if (recipe !== undefined && owner.policy === undefined) {throw invalidTarget();}
  const selected = recipe === undefined ? undefined :
    selectNodeDockerRoute(recipe, binding, owner.policy!, owner.route);
  const route = Object.freeze({...owner.route, binding, engine: selected?.engine ?? owner.route.engine,
    ...(selected === undefined ? {} : {preparation: selected.preparation})});
  const admission = createDockerLinuxExclusiveRouteAdmission(route);
  selectedAdmissions.set(route, selected === undefined ? admission : Object.freeze({
    async admit(request: Parameters<DockerLinuxOperationRouteAdmission["admit"]>[0]) {
      const refused = {kind: "unsupported" as const, reason: "owner" as const};
      if (!selected.isOpen()) {return refused;}
      const result = await admission.admit(request);
      if (!selected.isOpen()) {
        if (result.kind === "installed") {result.owner.revoke();}
        return refused;
      }
      return result;
    },
    releaseAfterContainerRemoval: admission.releaseAfterContainerRemoval,
  }));
  return route;
}

/** Resolve only the exact selected route, never a structural copy or Proxy. */
export const readContainedTurnSelectedRouteAdmission = (
  route: DockerLinuxExclusiveRouteAdmissionInput,
): DockerLinuxOperationRouteAdmission | undefined => selectedAdmissions.get(route);
