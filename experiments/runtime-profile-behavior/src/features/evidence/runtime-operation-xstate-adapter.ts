import type { CrossAxis } from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";

export type SyntheticCrossAxisTransition = {
  fact: string;
  targets: readonly {
    axis: string;
    from: string;
    to: string;
  }[];
  requiredState?: Readonly<Record<string, readonly string[]>>;
  requiredFacts?: readonly string[];
};

export type SyntheticCrossAxisEvent = {
  type: string;
  facts: readonly string[];
};

export type SyntheticCrossAxisModel = {
  requirement: 27;
  machineKind: "synthetic-verifier";
  initial: Readonly<Record<string, string>>;
  axes: Readonly<Record<string, readonly string[]>>;
  transitions: readonly SyntheticCrossAxisTransition[];
  forbiddenTransitionFacts: readonly string[];
};

export const syntheticCrossAxisModelFromAuthority = (
  authority: CrossAxis,
): SyntheticCrossAxisModel => ({
  requirement: 27,
  machineKind: "synthetic-verifier",
  initial: authority.initial as unknown as Readonly<Record<string, string>>,
  axes: authority.axes as unknown as Readonly<Record<string, readonly string[]>>,
  transitions: authority.transitions,
  forbiddenTransitionFacts: authority.forbiddenTransitionFacts,
});
