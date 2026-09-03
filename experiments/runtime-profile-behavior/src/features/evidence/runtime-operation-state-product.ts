export type GeneratedState = {
  dispatch: "unclaimed" | "claimed" | "acceptance_unknown" | "known_not_accepted" | "provider_accepted";
  admission: "open" | "fenced";
  output: "open" | "fenced";
  execution: "not_started" | "active" | "terminated";
  containment: "not_requested" | "pending" | "contained" | "uncertain" | "qualified_not_required";
  reconciliation: "clear" | "required";
  manifest: "open" | "sealed";
  satisfaction: "incomplete" | "complete";
  effectResolution: "none" | "unresolved" | "resolved" | "indeterminate";
  terminal: "open" | "succeeded" | "failed" | "cancelled" | "outcome_indeterminate";
};

export type StateProductAxes = {
  [Axis in keyof GeneratedState]: readonly GeneratedState[Axis][];
};

export const SUPPORTED_STATE_PRODUCT_AXES: StateProductAxes = {
  dispatch: ["unclaimed", "claimed", "acceptance_unknown", "known_not_accepted", "provider_accepted"],
  admission: ["open", "fenced"],
  output: ["open", "fenced"],
  execution: ["not_started", "active", "terminated"],
  containment: ["not_requested", "pending", "contained", "uncertain", "qualified_not_required"],
  reconciliation: ["clear", "required"],
  manifest: ["open", "sealed"],
  satisfaction: ["incomplete", "complete"],
  effectResolution: ["none", "unresolved", "resolved", "indeterminate"],
  terminal: ["open", "succeeded", "failed", "cancelled", "outcome_indeterminate"],
};

const assertSupportedAxes = (axes: StateProductAxes): void => {
  if (JSON.stringify(axes) !== JSON.stringify(SUPPORTED_STATE_PRODUCT_AXES)) {
    throw new Error("runtime-operation state product: JSON axes differ from handwritten semantics");
  }
};

const executionMatchesDispatch = (state: GeneratedState): boolean =>
  (state.dispatch === "unclaimed" && state.execution === "not_started") ||
  (state.dispatch === "claimed" && state.execution === "active") ||
  (state.dispatch === "acceptance_unknown" && ["active", "terminated"].includes(state.execution)) ||
  (state.dispatch === "known_not_accepted" && state.execution === "not_started") ||
  (state.dispatch === "provider_accepted" && ["active", "terminated"].includes(state.execution));

export const generatedStateIsValid = (state: GeneratedState): boolean => {
  if (!executionMatchesDispatch(state)) {
    return false;
  }
  if (state.manifest === "sealed" && (state.admission !== "fenced" || state.output !== "fenced")) {
    return false;
  }
  if (state.satisfaction === "complete" && state.manifest !== "sealed") {
    return false;
  }
  if (state.satisfaction === "complete" && state.effectResolution === "unresolved") {
    return false;
  }
  if (state.containment === "qualified_not_required" &&
      (state.admission !== "fenced" || state.output !== "fenced" || state.execution === "active")) {
    return false;
  }
  if (state.dispatch === "acceptance_unknown" && state.terminal === "open" &&
      state.reconciliation !== "required") {
    return false;
  }
  if (state.terminal === "open") {
    return true;
  }
  const effectClosed = state.terminal === "outcome_indeterminate"
    ? ["none", "indeterminate"].includes(state.effectResolution)
    : ["none", "resolved"].includes(state.effectResolution);
  return effectClosed &&
    state.admission === "fenced" &&
    state.output === "fenced" &&
    state.execution !== "active" &&
    !["pending", "uncertain"].includes(state.containment) &&
    state.reconciliation === "clear" &&
    state.manifest === "sealed" &&
    state.satisfaction === "complete";
};

export const stateProductSize = (axes: StateProductAxes): number =>
  Object.values(axes).reduce((product, values) => product * values.length, 1);

export const stateAt = (axes: StateProductAxes, index: number): GeneratedState => {
  let quotient = index;
  const take = <Axis extends keyof GeneratedState>(axis: Axis): GeneratedState[Axis] => {
    const values = axes[axis];
    const value = values[quotient % values.length];
    quotient = Math.floor(quotient / values.length);
    if (value === undefined) {
      throw new Error(`runtime-operation state product: empty axis ${axis}`);
    }
    return value;
  };
  return {
    dispatch: take("dispatch"),
    admission: take("admission"),
    output: take("output"),
    execution: take("execution"),
    containment: take("containment"),
    reconciliation: take("reconciliation"),
    manifest: take("manifest"),
    satisfaction: take("satisfaction"),
    effectResolution: take("effectResolution"),
    terminal: take("terminal"),
  };
};

export const projectedStateHasValidExtension = (
  axes: StateProductAxes,
  projection: Readonly<Record<string, string>>,
): boolean => {
  assertSupportedAxes(axes);
  for (const [axis, value] of Object.entries(projection)) {
    if (!(axis in axes)) {
      throw new Error(`runtime-operation state product: unknown projected axis ${axis}`);
    }
    const supported = axes[axis as keyof StateProductAxes] as readonly string[];
    if (axis === "terminal" && value === "final") {
      continue;
    }
    if (!supported.includes(value)) {
      throw new Error(`runtime-operation state product: unknown projected value ${axis}.${value}`);
    }
  }
  const total = stateProductSize(axes);
  for (let index = 0; index < total; index += 1) {
    const state = stateAt(axes, index);
    const matches = Object.entries(projection).every(([axis, value]) => {
      const actual = state[axis as keyof GeneratedState];
      return axis === "terminal" && value === "final" ? actual !== "open" : actual === value;
    });
    if (matches && generatedStateIsValid(state)) {
      return true;
    }
  }
  return false;
};

export const evaluateGeneratedAxisProducts = (
  axes: StateProductAxes,
): { total: number; valid: number; invalid: number } => {
  assertSupportedAxes(axes);
  const total = stateProductSize(axes);
  let valid = 0;
  for (let index = 0; index < total; index += 1) {
    if (generatedStateIsValid(stateAt(axes, index))) {
      valid += 1;
    }
  }
  return { total, valid, invalid: total - valid };
};

export const createStateProductEvaluator = (
  authority: { catalog: Catalog },
): {
  axes: StateProductAxes;
  stateIsValid: typeof generatedStateIsValid;
  projectedStateHasValidExtension: (projection: Readonly<Record<string, string>>) => boolean;
  evaluate: () => { total: number; valid: number; invalid: number };
} => {
  const axes = authority.catalog.stateProductAxes as StateProductAxes;
  assertSupportedAxes(axes);
  return {
    axes,
    stateIsValid: generatedStateIsValid,
    projectedStateHasValidExtension: (projection) => projectedStateHasValidExtension(axes, projection),
    evaluate: () => evaluateGeneratedAxisProducts(axes),
  };
};
import type { Catalog } from "../../../fixtures/proof-artifacts/runtime-operation-oracle/runtime-operation-oracle-types.generated.ts";
