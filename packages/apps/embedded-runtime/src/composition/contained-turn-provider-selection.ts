import type { ContainedTurnHostProviderSelection } from "./contained-turn-feature-composition.js";

export interface ContainedTurnProviderSelectionSnapshot {
  readonly selection: ContainedTurnHostProviderSelection;
  assertStable(): void;
}

const invalidSelection = (): TypeError => new TypeError("Contained turn provider selection is invalid");

const sameDescriptor = (left: PropertyDescriptor, right: PropertyDescriptor): boolean =>
  left.value === right.value && left.enumerable === right.enumerable &&
  left.configurable === right.configurable && left.writable === right.writable;

const ownDataDescriptor = (value: object, key: PropertyKey): PropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw invalidSelection();
  }
  return descriptor;
};

const assertExactSelectionKeys = (selection: object): void => {
  const keys = Reflect.ownKeys(selection);
  if (keys.length !== 2 || keys.some(key => typeof key !== "string") ||
      keys.toSorted().join("\0") !== "kind\0owner") {
    throw invalidSelection();
  }
};

/**
 * Captures the tagged provider choice only through exact own data descriptors.
 * A Proxy is rejected when its observable traps drift, but JavaScript exposes no
 * sound universal Proxy detector; an observationally ordinary Proxy is equivalent here.
 */
export const snapshotContainedTurnProviderSelection = (
  dependencies: unknown,
): ContainedTurnProviderSelectionSnapshot => {
  try {
    if (typeof dependencies !== "object" || dependencies === null) {throw invalidSelection();}
    const selectionDescriptor = ownDataDescriptor(dependencies, "selectedProvider");
    const selection = selectionDescriptor.value;
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      throw invalidSelection();
    }
    const prototype = Object.getPrototypeOf(selection);
    if (prototype !== Object.prototype && prototype !== null) {throw invalidSelection();}
    assertExactSelectionKeys(selection);
    const kindDescriptor = ownDataDescriptor(selection, "kind");
    const ownerDescriptor = ownDataDescriptor(selection, "owner");
    if (kindDescriptor.value !== "codex" && kindDescriptor.value !== "claude") {
      throw invalidSelection();
    }
    const assertStableUnchecked = (): void => {
      assertExactSelectionKeys(selection);
      if (!sameDescriptor(kindDescriptor, ownDataDescriptor(selection, "kind")) ||
          !sameDescriptor(ownerDescriptor, ownDataDescriptor(selection, "owner")) ||
          !sameDescriptor(selectionDescriptor, ownDataDescriptor(dependencies, "selectedProvider"))) {
        throw invalidSelection();
      }
    };
    const assertStable = (): void => {
      try {
        assertStableUnchecked();
      } catch {
        throw invalidSelection();
      }
    };
    assertStable();
    return Object.freeze({
      assertStable,
      selection: Object.freeze({kind: kindDescriptor.value, owner: ownerDescriptor.value}) as
        ContainedTurnHostProviderSelection,
    });
  } catch {
    throw invalidSelection();
  }
};
