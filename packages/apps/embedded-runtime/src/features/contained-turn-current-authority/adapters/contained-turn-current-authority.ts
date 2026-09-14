import {
  createContainedTurnOperationProviderAccessPort,
  createContainedTurnProviderAccessPort,
  createContainedTurnSecurityAcceptancePort,
  type ContainedTurnFeatureDependencies,
  type ContainedTurnSecurityAcceptanceProfile,
  type OuterContainedTurnProviderAccess,
  type OuterContainedTurnProviderAccessOperation,
  type OuterContainedTurnRuntimeSecurityAuthority,
  type OuterContainedTurnSecurityAcceptance,
} from "@agent-teams/agent-execution/composition";

/** Trusted private deployment selection. Omission retains the legacy candidate binding. */
export type ContainedTurnAuthorityDependencies =
  | Readonly<{
    authority?: "legacy";
    providerAccess: OuterContainedTurnProviderAccess;
    security: Readonly<{
      dispatchAuthorityV1: OuterContainedTurnRuntimeSecurityAuthority;
      legacy: Pick<ContainedTurnFeatureDependencies["security"], "authorizeForAcceptance" | "revalidateForDispatch">;
    }>;
  }>
  | Readonly<{
    authority: "current";
    providerAccess: OuterContainedTurnProviderAccessOperation;
    security: Readonly<{
      acceptance: OuterContainedTurnSecurityAcceptance;
      profile: ContainedTurnSecurityAcceptanceProfile;
    }>;
  }>;

type NodeUtilTypes = Readonly<{ isProxy(value: unknown): boolean }>;
const isProxy = (process.getBuiltinModule("node:util") as Readonly<{types: NodeUtilTypes}>).types.isProxy;
const descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isFrozen = Object.isFrozen;
const freeze = Object.freeze;
const invalid = () => new TypeError("Contained turn current authority selection is invalid");

const data = (record: object, key: string): unknown => {
  const field = descriptor(record, key);
  if (field === undefined || !("value" in field)) {throw invalid();}
  return field.value;
};

const captureCurrentSecurity = (security: unknown) => {
  if (security === null || typeof security !== "object" || isProxy(security) ||
      (prototype(security) !== Object.prototype && prototype(security) !== null) || !isFrozen(security)) {
    throw invalid();
  }
  const keys = ownKeys(security);
  if (keys.length !== 2 || !keys.includes("acceptance") || !keys.includes("profile")) {throw invalid();}
  return freeze({acceptance: data(security, "acceptance"), profile: data(security, "profile")});
};

/** Read no getters or Proxy traps, including an invalid discriminator's value. */
export const snapshotContainedTurnAuthority = (input: unknown): Readonly<{
  selection: ContainedTurnAuthorityDependencies;
  providerAccess: ContainedTurnFeatureDependencies["providerAccess"];
}> => {
  if (input === null || typeof input !== "object" || isProxy(input)) {
    throw new TypeError("Contained turn Provider Access dependency is invalid");
  }
  const selection = descriptor(input, "authority");
  if (selection !== undefined && (!("value" in selection) ||
      (selection.value !== "legacy" && selection.value !== "current"))) {throw invalid();}
  const access = descriptor(input, "providerAccess");
  if (access === undefined || !("value" in access)) {
    throw new TypeError("Contained turn Provider Access dependency is invalid");
  }
  // Preserve Route C validation before inspecting any downstream dependency.
  const providerAccess = selection?.value === "current"
    ? createContainedTurnOperationProviderAccessPort(access.value as OuterContainedTurnProviderAccessOperation)
    : createContainedTurnProviderAccessPort(access.value as OuterContainedTurnProviderAccess);
  const security = data(input, "security");
  if (selection?.value !== "current") {
    if (security !== null && typeof security === "object" &&
        (isProxy(security) || descriptor(security, "acceptance") !== undefined || descriptor(security, "profile") !== undefined)) {
      throw invalid();
    }
    return freeze({selection: freeze({providerAccess: access.value, security}) as ContainedTurnAuthorityDependencies, providerAccess});
  }
  return freeze({providerAccess, selection: freeze({authority: "current", providerAccess: access.value,
    security: captureCurrentSecurity(security),
  }) as ContainedTurnAuthorityDependencies});
};

/** Existing owner ACLs own all validation and accepted preparation publication. */
export const captureContainedTurnCurrentAuthority = (
  selection: Extract<ContainedTurnAuthorityDependencies, {authority: "current"}>,
  providerAccess: ContainedTurnFeatureDependencies["providerAccess"],
): Pick<ContainedTurnFeatureDependencies, "providerAccess" | "security"> => freeze({
  providerAccess,
  security: createContainedTurnSecurityAcceptancePort(selection.security.acceptance, selection.security.profile),
});
