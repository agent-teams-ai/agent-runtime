import {
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
  createContainedTurnFeature,
  readContainedTurnRouteEnforcementTarget,
  createContainedTurnProviderAccessPort,
  createContainedTurnRuntimeSecurityPort,
  type ClaudeCurrentKernelOwner,
  type CodexCurrentKernelOwner,
  type ContainedTurnFeatureDependencies,
  type CreateClaudeCurrentKernelOwnerOptions,
  type CreateCodexCurrentKernelOwnerOptions,
  type ContainedTurnRouteEnforcementCapability,
  type ContainedTurnRouteQualificationTarget,
  type OuterContainedTurnProviderAccess,
  type OuterContainedTurnRuntimeSecurityAuthority,
} from "@agent-teams/agent-execution/composition";
import {
  PRODUCT_QUALIFICATION_REGISTRY,
  registryQualifiesRouteTarget,
} from "./contained-turn-route-qualification.js";
import type { ContainedTurnCapabilityBundle } from "./contained-turn-runtime-access.js";
import {
  ContainedTurnOwnerDisposalError,
  disposeAfterContainedTurnConstructionFailure,
} from "./contained-turn-construction-failure.js";
import {
  snapshotContainedTurnProviderSelection,
  type ContainedTurnProviderSelectionSnapshot,
} from "./contained-turn-provider-selection.js";

export interface ContainedTurnOuterCompositionDependencies
  extends Omit<ContainedTurnFeatureDependencies, "providerAccess" | "security"> {
  readonly providerAccess: OuterContainedTurnProviderAccess;
  readonly security: Readonly<{
    dispatchAuthorityV1: OuterContainedTurnRuntimeSecurityAuthority;
    legacy: Pick<ContainedTurnFeatureDependencies["security"], "authorizeForAcceptance" | "revalidateForDispatch">;
  }>;
}

type HostCustodyAuthority = CreateCodexCurrentKernelOwnerOptions["hostCustody"] &
  CreateClaudeCurrentKernelOwnerOptions["hostCustody"];

export type ContainedTurnHostProviderSelection =
  | Readonly<{
    readonly kind: "claude";
    readonly owner: Omit<CreateClaudeCurrentKernelOwnerOptions, "hostCustody">;
  }>
  | Readonly<{
    readonly kind: "codex";
    readonly owner: Omit<CreateCodexCurrentKernelOwnerOptions, "hostCustody">;
  }>;

export interface HostCustodiedContainedTurnDependencies
  extends Omit<ContainedTurnOuterCompositionDependencies, "custody" | "provider"> {
  /** One operation-scoped authority shared by the custody and provider adapters. */
  readonly hostCustody: HostCustodyAuthority;
  readonly selectedProvider: ContainedTurnHostProviderSelection;
  /**
   * The enforced-route capability, obtainable only from Agent Execution's
   * Linux exclusive route owner factory. It is optional in this type because
   * absence is a normal, honest state of this repository, not a caller
   * convenience: the product entrypoint refuses every dependency set without
   * an authentic one.
   */
  readonly routeEnforcement?: ContainedTurnRouteEnforcementCapability;
}

export interface HostCustodiedContainedTurnComposition {
  readonly feature: ContainedTurnCapabilityBundle;
  dispose(): void;
}

export interface ContainedTurnProviderOwnerFactories {
  readonly claude: typeof createClaudeCurrentKernelOwner;
  readonly codex: typeof createCodexCurrentKernelOwner;
}

export const PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON =
  "route-enforcement-unqualified" as const;

/**
 * Stable construction failure for provider candidates whose exact Provider
 * Access network route has not been promoted in the qualification registry.
 */
export class ProviderRouteEnforcementUnsupportedError extends Error {
  public readonly reason = PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON;

  public constructor() {
    super(PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON);
    this.name = "ProviderRouteEnforcementUnsupportedError";
    Object.freeze(this);
  }
}

const trustedApply = Reflect.apply;
const trustedBind = Function.prototype.bind;
const trustedFreeze = Object.freeze;
const trustedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const trustedGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const trustedGetPrototypeOf = Object.getPrototypeOf;
const trustedIsExtensible = Object.isExtensible;
const trustedOwnKeys = Reflect.ownKeys;
const trustedObjectPrototype = Object.prototype;
type NodeUtilTypes = Readonly<{ isProxy(value: unknown): boolean }>;
const trustedIsProxy = (process.getBuiltinModule("node:util") as Readonly<{ types: NodeUtilTypes }>).types.isProxy;

const invalidProviderOwner = (): TypeError => new TypeError("Contained turn provider owner is invalid");
const invalidProviderAccessDependency = (): TypeError =>
  new TypeError("Contained turn Provider Access dependency is invalid");

const isExactProviderOwnerRecord = (value: unknown): value is object => {
  if (value === null || typeof value !== "object" || trustedIsProxy(value) ||
      trustedGetPrototypeOf(value) !== trustedObjectPrototype || trustedIsExtensible(value)) {
    return false;
  }
  const keys = trustedOwnKeys(value);
  if (keys.length !== 3) {return false;}
  const expectedKeys = ["custody", "dispose", "provider"] as const;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !expectedKeys.includes(key as never)) {return false;}
  }
  return true;
};

const stableDataValue = (descriptor: PropertyDescriptor | undefined): unknown => {
  if (descriptor === undefined || !("value" in descriptor) || descriptor.configurable !== false) {
    throw invalidProviderOwner();
  }
  return descriptor.value;
};

const captureProviderOwnerDispose = (owner: object, value: unknown): (() => void) => {
  if (typeof value !== "function" || trustedIsProxy(value) ||
      trustedGetOwnPropertyDescriptor(value, "bind") !== undefined) {
    throw invalidProviderOwner();
  }
  const bound = trustedApply(trustedBind, value, [owner]) as unknown;
  if (typeof bound !== "function") {throw invalidProviderOwner();}
  return trustedFreeze(bound) as () => void;
};

const captureProviderOwner = (
  value: unknown,
): ClaudeCurrentKernelOwner | CodexCurrentKernelOwner => {
  try {
    if (!isExactProviderOwnerRecord(value)) {throw invalidProviderOwner();}
    const descriptors = trustedGetOwnPropertyDescriptors(value);
    const custody = stableDataValue(descriptors.custody);
    const dispose = captureProviderOwnerDispose(value, stableDataValue(descriptors.dispose));
    const provider = stableDataValue(descriptors.provider);
    return trustedFreeze({
      custody,
      dispose,
      provider,
    }) as ClaudeCurrentKernelOwner | CodexCurrentKernelOwner;
  } catch {
    throw invalidProviderOwner();
  }
};

const captureProviderAccessDependency = (
  dependencies: ContainedTurnOuterCompositionDependencies,
): OuterContainedTurnProviderAccess => {
  let owner: OuterContainedTurnProviderAccess;
  try {
    if (trustedIsProxy(dependencies)) {
      throw invalidProviderAccessDependency();
    }
    const descriptor = trustedGetOwnPropertyDescriptor(dependencies, "providerAccess");
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidProviderAccessDependency();
    }
    owner = descriptor.value as OuterContainedTurnProviderAccess;
  } catch {
    throw invalidProviderAccessDependency();
  }
  createContainedTurnProviderAccessPort(owner);
  return owner;
};

const createSelectedProviderOwner = (
  snapshot: ContainedTurnProviderSelectionSnapshot,
  hostCustody: HostCustodyAuthority,
  factories: ContainedTurnProviderOwnerFactories,
): ClaudeCurrentKernelOwner | CodexCurrentKernelOwner => {
  const selection = snapshot.selection;
  switch (selection.kind) {
    case "claude": {
      const options = {...selection.owner, hostCustody};
      snapshot.assertStable();
      return captureProviderOwner(factories.claude(options));
    }
    case "codex": {
      const options = {...selection.owner, hostCustody};
      snapshot.assertStable();
      return captureProviderOwner(factories.codex(options));
    }
    default: throw new TypeError("Contained turn provider selection is invalid");
  }
};

/** The only cross-context binding from Provider Access into Agent Execution. */
export const createContainedTurnFeatureFromProviderAccess = (
  dependencies: ContainedTurnOuterCompositionDependencies,
): ContainedTurnCapabilityBundle => {
  // Product composition gates unqualified candidates before this exact seven-port
  // binding. Candidate evidence still closes Route C before publishing a handle.
  const providerAccess = createContainedTurnProviderAccessPort(
    captureProviderAccessDependency(dependencies),
  );
  return createContainedTurnFeature(Object.freeze({
    operationStore: dependencies.operationStore,
    security: createContainedTurnRuntimeSecurityPort(
      dependencies.security.legacy, dependencies.security.dispatchAuthorityV1,
    ),
    providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody: dependencies.custody,
    provider: dependencies.provider,
  }));
};

/** Internal deterministic candidate seam used only by synthetic tests and live implementation canaries. */
export const composeHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
  ownerFactories: ContainedTurnProviderOwnerFactories,
  featureFactory: typeof createContainedTurnFeatureFromProviderAccess,
): HostCustodiedContainedTurnComposition => {
  const providerAccess = captureProviderAccessDependency(
    dependencies as unknown as ContainedTurnOuterCompositionDependencies,
  );
  const selectedProvider = snapshotContainedTurnProviderSelection(dependencies);
  const owner = createSelectedProviderOwner(
    selectedProvider, dependencies.hostCustody, ownerFactories,
  );
  let feature: ContainedTurnCapabilityBundle;
  try {
    feature = featureFactory(Object.freeze({
      operationStore: dependencies.operationStore,
      security: dependencies.security,
      providerAccess,
      workspace: dependencies.workspace,
      artifacts: dependencies.artifacts,
      custody: owner.custody,
      provider: owner.provider,
    }));
  } catch (error) {
    return disposeAfterContainedTurnConstructionFailure(error, () => owner.dispose());
  }
  let disposed = false;
  return Object.freeze({
    feature,
    dispose() {
      if (disposed) {return;}
      try {
        owner.dispose();
      } catch {
        throw new ContainedTurnOwnerDisposalError();
      }
      disposed = true;
    },
  });
};

const productOwnerFactories: ContainedTurnProviderOwnerFactories = Object.freeze({
  claude: createClaudeCurrentKernelOwner, codex: createCodexCurrentKernelOwner,
});

/** @internal Candidate-only assembly for repository-owned synthetic evidence. */
export const composeCandidateHostCustodiedContainedTurnForImplementationEvidence = (
  dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => composeHostCustodiedContainedTurn(
  dependencies,
  productOwnerFactories,
  createContainedTurnFeatureFromProviderAccess,
);

/** The observed Host platform tuple. The exclusive route is a Linux namespace
 * effect, so a registry tuple promoted for another platform never matches here
 * and Darwin stays refused without a platform special case. */
const observedPlatformTarget = (): string => `${process.platform}-${process.arch}`;

/**
 * Resolves the promoted target of an authentic route-enforcement capability.
 * Nothing is read from the dependency set before it is known not to be a
 * Proxy, and nothing at all is read from the candidate capability: an
 * unminted, structural or proxied value resolves to no target.
 */
const requireRouteEnforcementTarget = (
  dependencies: HostCustodiedContainedTurnDependencies,
): ContainedTurnRouteQualificationTarget => {
  if (dependencies === null || typeof dependencies !== "object" || trustedIsProxy(dependencies)) {
    throw new ProviderRouteEnforcementUnsupportedError();
  }
  const descriptor = trustedGetOwnPropertyDescriptor(dependencies, "routeEnforcement");
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new ProviderRouteEnforcementUnsupportedError();
  }
  const target = readContainedTurnRouteEnforcementTarget(descriptor.value);
  if (target === undefined || target.platform !== observedPlatformTarget()) {
    throw new ProviderRouteEnforcementUnsupportedError();
  }
  return target;
};

/**
 * @internal Registry-gated assembly. Two independent facts admit a product
 * composition, and neither is a caller boolean: an authentic route-enforcement
 * capability, which only the Linux exclusive route owner factory mints, and an
 * exact whole-tuple promotion in the supplied qualification registry. Every
 * other outcome, including any failure while establishing either fact, is the
 * same stable construction refusal. The registry is a parameter so that the
 * positive path can be exercised against a fixture registry without claiming a
 * promotion the repository has not made.
 */
export const composeQualifiedHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
  ownerFactories: ContainedTurnProviderOwnerFactories,
  featureFactory: typeof createContainedTurnFeatureFromProviderAccess,
  qualificationRegistry: URL,
): HostCustodiedContainedTurnComposition => {
  let qualified = false;
  try {
    qualified = registryQualifiesRouteTarget(
      qualificationRegistry, requireRouteEnforcementTarget(dependencies),
    );
  } catch {
    throw new ProviderRouteEnforcementUnsupportedError();
  }
  if (!qualified) {throw new ProviderRouteEnforcementUnsupportedError();}
  return composeHostCustodiedContainedTurn(dependencies, ownerFactories, featureFactory);
};

/**
 * Product/default composition. Codex and Claude remain candidate
 * implementations until an exact enforced-egress route is promoted: this
 * repository's registry holds no such promotion, so this entrypoint still
 * refuses every dependency set today, now because the exact target tuple is
 * unqualified rather than because construction was never attempted.
 */
export const createHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => composeQualifiedHostCustodiedContainedTurn(
  dependencies,
  productOwnerFactories,
  createContainedTurnFeatureFromProviderAccess,
  PRODUCT_QUALIFICATION_REGISTRY,
);
