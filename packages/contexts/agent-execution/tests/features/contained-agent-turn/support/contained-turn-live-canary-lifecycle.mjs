import { types } from "node:util";

import {
  createContainedTurnProviderAccessPort,
  createContainedTurnRuntimeSecurityPort,
} from "../../../../dist/composition.js";

const unqualified = () => Object.assign(new Error("route-enforcement-unqualified"), {
  reason: "route-enforcement-unqualified",
});

/** Own data properties only; an accessor never runs on this path. */
const dataValue = (record, key) => {
  const field = Object.getOwnPropertyDescriptor(record, key);
  return field !== undefined && "value" in field ? field.value : undefined;
};

const isCandidateRecord = value =>
  value !== null && typeof value === "object" && !types.isProxy(value) && Object.isFrozen(value);

const LEGACY_SECURITY_METHODS = Object.freeze(["authorizeForAcceptance", "revalidateForDispatch"]);
const DISPATCH_AUTHORITY_METHODS = Object.freeze([
  "consumeForDispatch", "observeDispatchConsumption", "settleDispatchConsumption",
]);

/** Exactly these methods, each an own non-proxied function value. */
const hasExactMethods = (record, methods) => {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== methods.length) {return false;}
  return methods.every(method => {
    const value = dataValue(record, method);
    return typeof value === "function" && !types.isProxy(value);
  });
};

/**
 * Runs the live-canary body around an exact kernel custody reservation.
 * A rejected open has no kernel reservation that this layer is authorized to
 * contain. Partial Host allocation must be represented by an explicit typed
 * cleanup/rollback result; this layer never infers that result.
 */
export const runContainedTurnLiveCanaryLifecycle = async input => {
  let failure;
  let failed = false;
  let opened = false;
  let physicalContainment;
  let value;
  const preserveFirstFailure = error => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };

  try {
    const reservation = await input.open();
    opened = true;
    value = await input.execute(reservation);
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (opened) {
    try {
      physicalContainment = await input.requestPhysicalContainment();
    } catch (error) {
      preserveFirstFailure(error);
    }
  }

  try {
    await input.dispose();
  } catch (error) {
    preserveFirstFailure(error);
  }

  if (failed) { throw failure; }
  return Object.freeze({ physicalContainment, value });
};
/**
 * No caller boolean, environment variable, or evidence document can authorize
 * the missing enforced route, and no synthetic grant receipt may stand in for
 * the owners below. The canary must be handed the real Provider Access owner
 * and the real Runtime Security dispatch authority; this gate then binds them
 * through the production anti-corruption ports and returns the exact feature
 * ports, so a caller-shaped grant is rejected by the repository's own owner
 * contract rather than by a check written for the canary.
 *
 * Authenticity is decided before a single property of the caller's object is
 * read: a proxied or non-object candidate is refused on identity alone.
 * @param {unknown} candidate
 * @returns {Pick<import('../../../../dist/features/contained-agent-turn/internal.js').ContainedTurnFeatureDependencies, 'security' | 'providerAccess'>}
 */
export const requireContainedTurnLiveCanaryAuthorities = candidate => {
  if (candidate === null || typeof candidate !== "object" || types.isProxy(candidate)) {throw unqualified();}
  const providerAccess = dataValue(candidate, "providerAccess");
  const security = dataValue(candidate, "security");
  if (!isCandidateRecord(providerAccess) || !isCandidateRecord(security)) {throw unqualified();}
  const legacy = dataValue(security, "legacy");
  const dispatchAuthorityV1 = dataValue(security, "dispatchAuthorityV1");
  if (!isCandidateRecord(legacy) || !isCandidateRecord(dispatchAuthorityV1) ||
      !hasExactMethods(legacy, LEGACY_SECURITY_METHODS) ||
      !hasExactMethods(dispatchAuthorityV1, DISPATCH_AUTHORITY_METHODS)) {
    throw unqualified();
  }
  try {
    return Object.freeze({
      providerAccess: createContainedTurnProviderAccessPort(providerAccess),
      security: createContainedTurnRuntimeSecurityPort(legacy, dispatchAuthorityV1),
    });
  } catch {
    throw unqualified();
  }
};
