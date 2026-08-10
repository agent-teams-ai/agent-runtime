import { adjacencyMapToArray, getAdjacencyMap, getShortestPaths } from "@xstate/graph";
import {
  and,
  createMachine,
  or,
  stateIn,
  transition as transitionMachine,
  type AnyStateMachine,
  type StateValue,
} from "xstate";

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

export type SyntheticCrossAxisModel = {
  requirement: 27;
  machineKind: "synthetic-verifier";
  initial: Readonly<Record<string, string>>;
  axes: Readonly<Record<string, readonly string[]>>;
  transitions: readonly SyntheticCrossAxisTransition[];
  forbiddenTransitionFacts: readonly string[];
};

type StateConfig = {
  on?: Record<string, unknown>;
};

const guardFor = (
  declaration: SyntheticCrossAxisTransition,
): ReturnType<typeof stateIn> | undefined => {
  const requiredState: Record<string, readonly string[]> = {
    ...declaration.requiredState,
  };
  for (const { axis, from } of declaration.targets) {
    const explicit = requiredState[axis];
    if (explicit !== undefined && !explicit.includes(from)) {
      throw new Error(`synthetic cross-axis machine: ${declaration.fact} contradicts ${axis} source`);
    }
    requiredState[axis] = [from];
  }
  const axisGuards = Object.entries(requiredState).map(([axis, values]) => {
    const guards = values.map((value) => stateIn({ [axis]: value }));
    return guards.length === 1 ? guards[0]! : or(guards);
  });
  return axisGuards.length === 1 ? axisGuards[0]! : and(axisGuards);
};

export const buildSyntheticCrossAxisMachine = (
  model: SyntheticCrossAxisModel,
): AnyStateMachine => {
  const states: Record<string, { initial: string; states: Record<string, StateConfig> }> = {};
  for (const [axis, values] of Object.entries(model.axes)) {
    const initial = model.initial[axis];
    if (initial === undefined || !values.includes(initial)) {
      throw new Error(`synthetic cross-axis machine: invalid initial state for ${axis}`);
    }
    states[axis] = {
      initial,
      states: Object.fromEntries(values.map((value) => [value, {}])),
    };
  }

  for (const declaration of model.transitions) {
    const guard = guardFor(declaration);
    for (const target of declaration.targets) {
      const state = states[target.axis]?.states[target.from];
      if (state === undefined || states[target.axis]?.states[target.to] === undefined) {
        throw new Error(`synthetic cross-axis machine: invalid target for ${declaration.fact}`);
      }
      state.on ??= {};
      state.on[declaration.fact] = guard === undefined
        ? { target: target.to }
        : { target: target.to, guard };
    }
  }

  return createMachine({
    id: "adr-0006-requirement-27-synthetic-verifier",
    type: "parallel",
    states,
  } as never) as AnyStateMachine;
};

const stateValue = (value: StateValue): Record<string, string> =>
  Object.fromEntries(Object.entries(value as Record<string, StateValue>).map(
    ([axis, axisValue]) => [axis, String(axisValue)],
  ));

const serializeState = (snapshot: { value: StateValue }): string =>
  JSON.stringify(Object.entries(stateValue(snapshot.value)).toSorted(([left], [right]) =>
    left.localeCompare(right),
  ));

export type SyntheticPathWitness = {
  fact: string;
  events: string[];
  source: Record<string, string>;
  target: Record<string, string>;
};

export const deriveShortestPathWitnesses = (
  machine: AnyStateMachine,
  transitions: readonly SyntheticCrossAxisTransition[],
): {
  reachableStateCount: number;
  reachableStates: Record<string, string>[];
  witnesses: SyntheticPathWitness[];
} => {
  const transitionFacts = transitions.map(({ fact }) => fact);
  const events = transitionFacts.map((type) => ({ type }));
  const traversal = { events, limit: 100_000, serializeState };
  const paths = getShortestPaths(machine, traversal);
  const adjacency = getAdjacencyMap(machine, traversal);
  const realizedFacts = new Set(adjacencyMapToArray(adjacency)
    .filter(({ state, nextState }) => serializeState(nextState) !== serializeState(state))
    .map(({ event }) => event.type));
  const missingFacts = transitionFacts.filter((fact) => !realizedFacts.has(fact));
  if (missingFacts.length > 0) {
    throw new Error(`synthetic cross-axis machine: unrealized edges ${missingFacts.join(", ")}`);
  }
  const witnesses = transitions.map((declared): SyntheticPathWitness => {
    const fact = declared.fact;
    const event = { type: fact };
    const candidates = paths
      .map((path) => {
        const [next] = transitionMachine(machine, path.state, event);
        return { path, next };
      })
      .filter(({ path, next }) => {
        const source = stateValue(path.state.value);
        const target = stateValue(next.value);
        const declaredTargetsMatch = declared.targets.every(({ axis, from, to }) =>
          source[axis] === from && target[axis] === to,
        );
        const requiredStateMatches = Object.entries(declared.requiredState ?? {}).every(
          ([axis, values]) => values.includes(source[axis] ?? ""),
        );
        return declaredTargetsMatch && requiredStateMatches;
      })
      .toSorted((left, right) => left.path.weight - right.path.weight);
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new Error(`synthetic cross-axis machine: no reachable witness for ${fact}`);
    }
    return {
      fact,
      events: [
        ...candidate.path.steps
          .map(({ event: stepEvent }) => stepEvent.type)
          .filter((type) => type !== "xstate.init"),
        fact,
      ],
      source: stateValue(candidate.path.state.value),
      target: stateValue(candidate.next.value),
    };
  });
  return {
    reachableStateCount: paths.length,
    reachableStates: paths.map(({ state }) => stateValue(state.value)),
    witnesses,
  };
};
