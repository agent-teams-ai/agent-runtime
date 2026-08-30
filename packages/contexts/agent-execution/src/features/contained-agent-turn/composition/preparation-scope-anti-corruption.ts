import {
  validateContainedTurnKernelDependencies,
  type ContainedTurnKernelDependencies,
} from "../application/ports/outbound/contained-turn-ports.js";
import {
  snapshotContainedTurnDispatchPreparation,
  snapshotContainedTurnOwnedOperation,
} from "../application/contained-turn-preparation-scope.js";
import { validateContainedTurnIdentity } from "../domain/contained-turn-identities.js";
import { CONTAINED_TURN_LIMITS, validateContainedTurnText } from "../domain/contained-turn-limits.js";
import {
  assertContainedTurnExactRecord,
  detachAndFreezeContainedTurnValue,
} from "../domain/contained-turn-record.js";

const nodeTypes = process.getBuiltinModule("node:util").types;

const PORT_VALUE_MAXIMUM_DEPTH = 32;
const PORT_VALUE_MAXIMUM_NODES = 16_384;
const PORT_VALUE_MAXIMUM_PROPERTIES = 16_384;

type PortScalar = boolean | number | string | null;
type PortValue = PortScalar | readonly PortValue[] | { readonly [key: string]: PortValue };
type PortCloneState = { readonly ancestors: WeakSet<object>; nodes: number; properties: number };

const readBoundedContainedTurnDescriptors = (
  candidate: object,
  state: PortCloneState,
): PropertyDescriptorMap => {
  const keys = Reflect.ownKeys(candidate);
  state.properties += keys.length;
  if (state.properties > PORT_VALUE_MAXIMUM_PROPERTIES) {
    throw new TypeError("owner port value exceeds the bounded property limit");
  }
  return Object.fromEntries(keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined) {throw new TypeError("owner port property changed during projection");}
    return [key, descriptor];
  })) as PropertyDescriptorMap;
};

const cloneContainedTurnPortArray = (
  candidate: unknown[],
  descriptors: PropertyDescriptorMap,
  depth: number,
  state: PortCloneState,
): PortValue[] => {
  const lengthDescriptor = descriptors.length;
  if (Object.getPrototypeOf(candidate) !== Array.prototype || lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0) {
    throw new TypeError("owner port arrays must be ordinary dense arrays");
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some(key => typeof key !== "string") ||
      Array.from({ length }, (_item, index) => String(index)).some(key => descriptors[key] === undefined)) {
    throw new TypeError("owner port arrays must be dense and unaugmented");
  }
  const output: PortValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("owner port arrays must contain only enumerable data elements");
    }
    output.push(cloneContainedTurnPortEntry(descriptor.value, depth + 1, state));
  }
  return output;
};

const cloneContainedTurnPortRecord = (
  candidate: object,
  descriptors: PropertyDescriptorMap,
  depth: number,
  state: PortCloneState,
): { readonly [key: string]: PortValue } => {
  if (Object.getPrototypeOf(candidate) !== Object.prototype) {
    throw new TypeError("owner port records must use the ordinary object prototype");
  }
  const entries: [string, PortValue][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {throw new TypeError("owner port records must not contain symbols");}
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("owner port records must contain only enumerable data properties");
    }
    entries.push([key, cloneContainedTurnPortEntry(descriptor.value, depth + 1, state)]);
  }
  return Object.fromEntries(entries) as { readonly [key: string]: PortValue };
};

const cloneContainedTurnPortEntry = (
  candidate: unknown,
  depth: number,
  state: PortCloneState,
): PortValue => {
  if (candidate === null || typeof candidate === "boolean" || typeof candidate === "number" ||
      typeof candidate === "string") {
    return candidate;
  }
  if (typeof candidate !== "object" || nodeTypes.isProxy(candidate)) {
    throw new TypeError("owner port values must contain only ordinary canonical data");
  }
  state.nodes += 1;
  if (state.nodes > PORT_VALUE_MAXIMUM_NODES || depth > PORT_VALUE_MAXIMUM_DEPTH ||
      state.ancestors.has(candidate)) {
    throw new TypeError("owner port value exceeds the bounded acyclic projection limits");
  }
  state.ancestors.add(candidate);
  try {
    const descriptors = readBoundedContainedTurnDescriptors(candidate, state);
    return Array.isArray(candidate)
      ? cloneContainedTurnPortArray(candidate, descriptors, depth, state)
      : cloneContainedTurnPortRecord(candidate, descriptors, depth, state);
  } finally {
    state.ancestors.delete(candidate);
  }
};

/** Rejects Proxy exotica before reflection and reads every caller property once. */
const cloneContainedTurnPortValue = <Value>(value: Value): Value => {
  const state: PortCloneState = { ancestors: new WeakSet<object>(), nodes: 0, properties: 0 };
  return cloneContainedTurnPortEntry(value, 0, state) as Value;
};

type GrantOwnerOutcome = Awaited<ReturnType<NonNullable<
  ContainedTurnKernelDependencies["providerAccess"]["consumeForDispatch"]
>>> | Awaited<ReturnType<NonNullable<
  ContainedTurnKernelDependencies["security"]["consumeForDispatch"]
>>>;

const projectGrantOwnerOutcome = <Outcome extends GrantOwnerOutcome>(outcome: Outcome): Outcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  if (safeOutcome.kind === "consumed") {
    assertContainedTurnExactRecord("consumed grant outcome", safeOutcome, ["kind", "receipt"]);
    return Object.freeze({
      kind: "consumed",
      receipt: detachAndFreezeContainedTurnValue(safeOutcome.receipt),
    }) as Outcome;
  }
  if (safeOutcome.kind === "prevented") {
    assertContainedTurnExactRecord("prevented grant outcome", safeOutcome, ["kind", "preventionProofId"]);
    return Object.freeze({
      kind: "prevented",
      preventionProofId: validateContainedTurnIdentity("proof", safeOutcome.preventionProofId),
    }) as Outcome;
  }
  if (safeOutcome.kind === "indeterminate") {
    assertContainedTurnExactRecord("indeterminate grant outcome", safeOutcome, ["evidenceId", "kind"]);
    return Object.freeze({
      evidenceId: validateContainedTurnIdentity("evidence", safeOutcome.evidenceId),
      kind: "indeterminate",
    }) as Outcome;
  }
  throw new TypeError("unknown grant owner outcome");
};

type ClaimOwnerOutcome = Awaited<ReturnType<NonNullable<
  ContainedTurnKernelDependencies["operationStore"]["claimPreparedDispatch"]
>>>;

const projectClaimOwnerOutcome = (outcome: ClaimOwnerOutcome): ClaimOwnerOutcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  if (safeOutcome.kind === "claimed") {
    assertContainedTurnExactRecord("claimed dispatch outcome", safeOutcome, ["kind", "operation", "startAuthority"]);
    validateContainedTurnText(
      "dispatch start authority",
      safeOutcome.startAuthority,
      CONTAINED_TURN_LIMITS.text.identifier,
    );
    return Object.freeze({
      kind: "claimed",
      operation: snapshotContainedTurnOwnedOperation(safeOutcome.operation),
      startAuthority: safeOutcome.startAuthority,
    });
  }
  if (safeOutcome.kind === "observed_claim") {
    assertContainedTurnExactRecord("observed claim outcome", safeOutcome, ["kind", "operation"]);
    return Object.freeze({
      kind: "observed_claim",
      operation: snapshotContainedTurnOwnedOperation(safeOutcome.operation),
    });
  }
  if (safeOutcome.kind === "stale") {
    assertContainedTurnExactRecord("stale claim outcome", safeOutcome, ["current", "kind"]);
    return Object.freeze({ current: snapshotContainedTurnOwnedOperation(safeOutcome.current), kind: "stale" });
  }
  if (safeOutcome.kind === "indeterminate") {
    assertContainedTurnExactRecord("indeterminate claim outcome", safeOutcome, ["evidenceId", "kind"]);
    return Object.freeze({
      evidenceId: validateContainedTurnIdentity("evidence", safeOutcome.evidenceId),
      kind: "indeterminate",
    });
  }
  if (safeOutcome.kind === "not_found") {
    assertContainedTurnExactRecord("not-found claim outcome", safeOutcome, ["kind"]);
    return Object.freeze({ kind: "not_found" });
  }
  throw new TypeError("unknown claim owner outcome");
};

type RetirementOwnerOutcome = Awaited<ReturnType<NonNullable<
  ContainedTurnKernelDependencies["operationStore"]["retireDispatchPreparation"]
>>>;

const projectRetirementOwnerOutcome = (outcome: RetirementOwnerOutcome): RetirementOwnerOutcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  if (safeOutcome.kind === "claimed") {
    assertContainedTurnExactRecord("retirement claimed outcome", safeOutcome, ["kind", "operation"]);
    return Object.freeze({ kind: "claimed", operation: snapshotContainedTurnOwnedOperation(safeOutcome.operation) });
  }
  if (safeOutcome.kind === "retired") {
    assertContainedTurnExactRecord("retirement retired outcome", safeOutcome, ["kind", "preparation"]);
    const preparation = snapshotContainedTurnDispatchPreparation(safeOutcome.preparation);
    if (preparation.kind !== "cleanup_pending") {throw new TypeError("retirement must return cleanup debt");}
    return Object.freeze({ kind: "retired", preparation });
  }
  if (safeOutcome.kind === "stale") {
    assertContainedTurnExactRecord("retirement stale outcome", safeOutcome, ["current", "kind"]);
    return Object.freeze({ current: snapshotContainedTurnOwnedOperation(safeOutcome.current), kind: "stale" });
  }
  if (safeOutcome.kind === "indeterminate") {
    assertContainedTurnExactRecord("retirement indeterminate outcome", safeOutcome, ["evidenceId", "kind"]);
    return Object.freeze({
      evidenceId: validateContainedTurnIdentity("evidence", safeOutcome.evidenceId),
      kind: "indeterminate",
    });
  }
  throw new TypeError("unknown retirement owner outcome");
};

type CleanupOwnerOutcome =
  | Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["custody"]["releaseRetiredReservation"]>>>
  | Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["providerAccess"]["settleConsumedGrant"]>>>
  | Awaited<ReturnType<NonNullable<ContainedTurnKernelDependencies["security"]["settleConsumedGrant"]>>>;

const projectCleanupOwnerOutcome = <Outcome extends CleanupOwnerOutcome>(outcome: Outcome): Outcome => {
  const safeOutcome = cloneContainedTurnPortValue(outcome);
  const successful = safeOutcome.kind === "released" || safeOutcome.kind === "already_released" ||
    safeOutcome.kind === "settled" || safeOutcome.kind === "already_settled";
  assertContainedTurnExactRecord(
    "cleanup owner outcome",
    safeOutcome,
    successful ? ["kind"] : ["evidenceId", "kind"],
  );
  if (successful) {return Object.freeze({ kind: safeOutcome.kind }) as Outcome;}
  if (safeOutcome.kind !== "indeterminate") {throw new TypeError("unknown cleanup owner outcome");}
  return Object.freeze({
    evidenceId: validateContainedTurnIdentity("evidence", safeOutcome.evidenceId),
    kind: "indeterminate",
  }) as Outcome;
};

const forwardPort = <Port extends object>(
  target: Port,
  overrides: Readonly<Record<PropertyKey, unknown>>,
): Port => {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(port, key) {
      if (Object.hasOwn(overrides, key)) {return overrides[key];}
      const value = Reflect.get(port, key, port) as unknown;
      if (typeof value !== "function") {return value;}
      if (!bound.has(key)) {bound.set(key, value.bind(port));}
      return bound.get(key);
    },
  });
};

const assertBoundaryPort = (name: string, port: object): void => {
  if (nodeTypes.isProxy(port)) {throw new TypeError(`${name} boundary port must not be a Proxy`);}
};

/**
 * The production preparation ACL. It preserves the seven-port authority while
 * ensuring application decisions see only detached, bounded canonical values.
 */
export const createContainedTurnPreparationScopeDependencies = (
  dependencies: ContainedTurnKernelDependencies,
): ContainedTurnKernelDependencies => {
  if (nodeTypes.isProxy(dependencies)) {
    throw new TypeError("contained-turn composition dependencies must not be a Proxy");
  }
  validateContainedTurnKernelDependencies(dependencies);
  assertBoundaryPort("operation store", dependencies.operationStore);
  assertBoundaryPort("Provider Access", dependencies.providerAccess);
  assertBoundaryPort("Runtime Security", dependencies.security);
  assertBoundaryPort("custody", dependencies.custody);

  const claim = dependencies.operationStore.claimPreparedDispatch;
  const retire = dependencies.operationStore.retireDispatchPreparation;
  const record = dependencies.operationStore.recordDispatchPreparationCleanup;
  const providerConsume = dependencies.providerAccess.consumeForDispatch;
  const providerSettle = dependencies.providerAccess.settleConsumedGrant;
  const securityConsume = dependencies.security.consumeForDispatch;
  const securitySettle = dependencies.security.settleConsumedGrant;
  const custodyRelease = dependencies.custody.releaseRetiredReservation;

  const operationStore = forwardPort(dependencies.operationStore, Object.freeze({
    ...(claim === undefined ? {} : {
      claimPreparedDispatch: async (input: Parameters<typeof claim>[0]) =>
        projectClaimOwnerOutcome(await dependencies.operationStore.claimPreparedDispatch!(input)),
    }),
    ...(record === undefined ? {} : {
      recordDispatchPreparationCleanup: async (input: Parameters<typeof record>[0]) =>
        snapshotContainedTurnDispatchPreparation(cloneContainedTurnPortValue(
          await dependencies.operationStore.recordDispatchPreparationCleanup!(input),
        )),
    }),
    ...(retire === undefined ? {} : {
      retireDispatchPreparation: async (input: Parameters<typeof retire>[0]) =>
        projectRetirementOwnerOutcome(await dependencies.operationStore.retireDispatchPreparation!(input)),
    }),
  }));
  const providerAccess = forwardPort(dependencies.providerAccess, Object.freeze({
    ...(providerConsume === undefined ? {} : {
      consumeForDispatch: async (input: Parameters<typeof providerConsume>[0]) =>
        projectGrantOwnerOutcome(await dependencies.providerAccess.consumeForDispatch!(input)),
    }),
    ...(providerSettle === undefined ? {} : {
      settleConsumedGrant: async (input: Parameters<typeof providerSettle>[0]) =>
        projectCleanupOwnerOutcome(await dependencies.providerAccess.settleConsumedGrant!(input)),
    }),
  }));
  const security = forwardPort(dependencies.security, Object.freeze({
    ...(securityConsume === undefined ? {} : {
      consumeForDispatch: async (input: Parameters<typeof securityConsume>[0]) =>
        projectGrantOwnerOutcome(await dependencies.security.consumeForDispatch!(input)),
    }),
    ...(securitySettle === undefined ? {} : {
      settleConsumedGrant: async (input: Parameters<typeof securitySettle>[0]) =>
        projectCleanupOwnerOutcome(await dependencies.security.settleConsumedGrant!(input)),
    }),
  }));
  const custody = forwardPort(dependencies.custody, Object.freeze(
    custodyRelease === undefined ? {} : {
      releaseRetiredReservation: async (input: Parameters<typeof custodyRelease>[0]) =>
        projectCleanupOwnerOutcome(await dependencies.custody.releaseRetiredReservation!(input)),
    },
  ));

  return Object.freeze({
    operationStore,
    security,
    providerAccess,
    workspace: dependencies.workspace,
    artifacts: dependencies.artifacts,
    custody,
    provider: dependencies.provider,
  });
};
