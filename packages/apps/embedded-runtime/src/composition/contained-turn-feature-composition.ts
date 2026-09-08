import {createLinuxCodexDeploymentResources, type LinuxCodexDeploymentInfrastructure} from "./linux-codex-deployment.js";
import { createLinuxCodexContainedTurnOwner, type LinuxCodexContainedTurnResources }
  from "./linux-codex-contained-turn-owner.js";
import {
  createClaudeCurrentKernelOwner,
  createCodexCurrentKernelOwner,
  createContainedTurnFeature,
  readContainedTurnRouteEnforcementTarget,
  createContainedTurnRuntimeSecurityPort,
  type ClaudeCurrentKernelOwner,
  type CodexCurrentKernelOwner,
  type ContainedTurnFeatureDependencies,
  type CreateClaudeCurrentKernelOwnerOptions,
  type CreateCodexCurrentKernelOwnerOptions,
  type ContainedTurnRouteEnforcementCapability,
  type ContainedTurnRouteQualificationTarget,
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
import {
  captureContainedTurnCurrentAuthority,
  snapshotContainedTurnAuthority,
  type ContainedTurnAuthorityDependencies,
} from "./contained-turn-current-authority.js";

export type ContainedTurnOuterCompositionDependencies =
  Omit<ContainedTurnFeatureDependencies, "providerAccess" | "security"> & ContainedTurnAuthorityDependencies;

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

export type HostCustodiedContainedTurnDependencies =
  Omit<ContainedTurnFeatureDependencies, "custody" | "provider" | "providerAccess" | "security"> &
  ContainedTurnAuthorityDependencies & {
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
  /** Trusted private deployment composition only; never read from workspace configuration. */
  readonly linuxCodex?: LinuxCodexContainedTurnResources;
  /** Production infrastructure for the private acknowledged resource assembly. */
  readonly linuxCodexDeployment?: LinuxCodexDeploymentInfrastructure;
};

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
 * Why a Claude candidate is refused, carried beside the unchanged `reason`
 * rather than instead of it. `readiness.md`, the runtime-security egress test
 * and both live canaries pin the single reason token, so a second reason value
 * would quietly widen a contract they read as one string; a separate optional
 * detail tells a reader which of the two refusals they are looking at without
 * touching that token. The distinction is not cosmetic: a registry promotion
 * lifts the unqualified-target refusal, and nothing in the registry can lift
 * this one.
 */
export const CLAUDE_ROUTE_ENFORCEMENT_UNSUPPORTED_DETAIL = "claude-broker-seam-absent" as const;

export type ProviderRouteEnforcementUnsupportedDetail =
  typeof CLAUDE_ROUTE_ENFORCEMENT_UNSUPPORTED_DETAIL;

/**
 * Stable construction failure for provider candidates whose exact Provider
 * Access network route has not been promoted in the qualification registry, or
 * whose provider has no seam that could enforce such a route at all. `detail`
 * is present only for the second, provider-level case.
 */
export class ProviderRouteEnforcementUnsupportedError extends Error {
  public readonly reason = PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON;
  public readonly detail: ProviderRouteEnforcementUnsupportedDetail | undefined;

  public constructor(detail?: ProviderRouteEnforcementUnsupportedDetail) {
    super(detail === undefined
      ? PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON
      : `${PROVIDER_ROUTE_ENFORCEMENT_UNQUALIFIED_REASON}: ${detail}`);
    this.name = "ProviderRouteEnforcementUnsupportedError";
    this.detail = detail;
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
  const {selection, providerAccess: capturedAccess} = snapshotContainedTurnAuthority(dependencies);
  const {providerAccess, security} = selection.authority === "current"
    ? captureContainedTurnCurrentAuthority(selection, capturedAccess)
    : {
      providerAccess: capturedAccess,
      security: createContainedTurnRuntimeSecurityPort(selection.security.legacy, selection.security.dispatchAuthorityV1),
    };
  return createContainedTurnFeature(Object.freeze({
    operationStore: dependencies.operationStore,
    security,
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
  // Preserve early Provider Access validation before constructing the provider.
  // Forward the captured selection; featureFactory binds its own owner ports
  // inside the existing construction cleanup boundary.
  const {selection: authority} = snapshotContainedTurnAuthority(dependencies);
  const selectedProvider = snapshotContainedTurnProviderSelection(dependencies);
  const owner = createSelectedProviderOwner(
    selectedProvider, dependencies.hostCustody, ownerFactories,
  );
  let feature: ContainedTurnCapabilityBundle;
  try {
    feature = featureFactory(Object.freeze({
      operationStore: dependencies.operationStore,
      ...authority,
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
 * Whether the dependency set selects Claude, read only as exact own data.
 *
 * Why Claude is refused here, ahead of both route-enforcement facts, and not
 * left to the registry: enforcing the exclusive network route is a property of
 * the Host-custodied broker seam, and only the Codex path has one. The Claude
 * adapter has no broker seam at all, so a Claude turn has nothing that could
 * open, hold or release the route the two facts below are about. Until the
 * registry promoted its first target, that was invisible — Claude and Codex
 * were both refused by the same absent row, so the honest provider-level
 * statement looked like a property of an empty registry. It is not, and this
 * check makes the statement in its own right.
 *
 * Why it must survive a hypothetical Claude capability and Claude registry
 * row: both would attest a route that no Claude code path can install, which
 * is a worse failure than this refusal — an enforcement claim with nothing
 * enforcing it. This check is therefore removed only by whoever builds the
 * Claude broker seam, as part of that work and deliberately. It is never
 * removed to let a registry row take effect.
 *
 * An unreadable, accessor-backed or proxied dependency set is not observed
 * here at all: it falls through to the two facts below, which refuse it
 * without reading it, exactly as they did before this check existed.
 */
const selectsClaudeProvider = (dependencies: HostCustodiedContainedTurnDependencies): boolean => {
  if (dependencies === null || typeof dependencies !== "object" || trustedIsProxy(dependencies)) {
    return false;
  }
  try {
    return snapshotContainedTurnProviderSelection(dependencies).selection.kind === "claude";
  } catch {
    return false;
  }
};

/**
 * @internal Registry-gated assembly. Two independent facts admit a product
 * composition, and neither is a caller boolean: an authentic route-enforcement
 * capability, which only the Linux exclusive route owner factory mints, and an
 * exact whole-tuple promotion in the supplied qualification registry. Every
 * other outcome, including any failure while establishing either fact, is the
 * same stable construction refusal. Ahead of both, a provider whose adapter has
 * no broker seam is refused outright, because for it no pair of facts could be
 * the truth. The registry is a parameter so that the positive path can be
 * exercised against a fixture registry without claiming a promotion the
 * repository has not made.
 */
export const composeQualifiedHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
  ownerFactories: ContainedTurnProviderOwnerFactories,
  featureFactory: typeof createContainedTurnFeatureFromProviderAccess,
  qualificationRegistry: URL,
): HostCustodiedContainedTurnComposition => {
  if (selectsClaudeProvider(dependencies)) {
    throw new ProviderRouteEnforcementUnsupportedError(CLAUDE_ROUTE_ENFORCEMENT_UNSUPPORTED_DETAIL);
  }
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

/** Private deployment entrypoint. Uses the same product qualification gate and
 * current authority root; it does not export a new application capability. */
const createLinuxCodexDeployment = (
  dependencies: Omit<Extract<HostCustodiedContainedTurnDependencies, {authority: "current"}>, "linuxCodex" | "linuxCodexDeployment">,
  infrastructure: LinuxCodexDeploymentInfrastructure,
) => {
  const {selection: provider} = snapshotContainedTurnProviderSelection(dependencies);
  if (provider.kind !== "codex" || provider.owner.platformTarget.platform !== "linux") {
    throw new TypeError("Linux Codex deployment requires Linux Codex owners");
  }
  const deployment = createLinuxCodexDeploymentResources(infrastructure, provider.owner);
  return composeQualifiedHostCustodiedContainedTurn(dependencies, Object.freeze({
    claude: createClaudeCurrentKernelOwner,
    codex: (options: Parameters<typeof createLinuxCodexContainedTurnOwner>[0]) => createLinuxCodexContainedTurnOwner(options, deployment.resources),
  }), input => {
    const {selection, providerAccess} = snapshotContainedTurnAuthority(input);
    if (selection.authority !== "current") {throw new TypeError("Linux Codex deployment requires current authority");}
    const ports = deployment.bindAuthority(captureContainedTurnCurrentAuthority(selection, providerAccess));
    return createContainedTurnFeature(Object.freeze({operationStore: input.operationStore, ...ports,
      workspace: input.workspace, artifacts: input.artifacts, custody: input.custody, provider: input.provider,
    }) satisfies ContainedTurnFeatureDependencies);
  }, PRODUCT_QUALIFICATION_REGISTRY);
};

/**
 * Product/default composition. The Claude path is refused outright while its
 * adapter has no broker seam, and never reaches the two facts. The Codex path
 * is conditional: this repository's registry now promotes exactly one Docker
 * Linux Codex target, so a dependency set carrying an authentic capability for
 * that exact tuple is admitted, and every other one — including every Codex
 * candidate without such a capability — is still refused as unqualified.
 */
export const createHostCustodiedContainedTurn = (
  dependencies: HostCustodiedContainedTurnDependencies,
): HostCustodiedContainedTurnComposition => {
  const deployment = dependencies !== null && typeof dependencies === "object" && !trustedIsProxy(dependencies)
    ? trustedGetOwnPropertyDescriptor(dependencies, "linuxCodexDeployment") : undefined;
  if (deployment !== undefined) {
    if (!("value" in deployment) || trustedGetOwnPropertyDescriptor(dependencies, "linuxCodex") !== undefined) {
      throw new TypeError("Linux Codex deployment selection is ambiguous");
    }
    const {selection} = snapshotContainedTurnAuthority(dependencies);
    if (selection.authority !== "current") {throw new TypeError("Linux Codex deployment requires current authority");}
    return createLinuxCodexDeployment(dependencies as Extract<HostCustodiedContainedTurnDependencies, {authority: "current"}>, deployment.value);
  }
  return composeQualifiedHostCustodiedContainedTurn(
    dependencies,
    Object.freeze({
      claude: createClaudeCurrentKernelOwner,
      codex: (options: CreateCodexCurrentKernelOwnerOptions) => {
        if (options.platformTarget.platform !== "linux") {return createCodexCurrentKernelOwner(options);}
        const descriptor = trustedGetOwnPropertyDescriptor(dependencies, "linuxCodex");
        return createLinuxCodexContainedTurnOwner(options,
          descriptor !== undefined && "value" in descriptor ? descriptor.value as LinuxCodexContainedTurnResources : undefined);
      },
    }),
    createContainedTurnFeatureFromProviderAccess,
    PRODUCT_QUALIFICATION_REGISTRY,
  );
};
