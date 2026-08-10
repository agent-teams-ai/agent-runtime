// Generated from ADR-0006 JSON authority. Do not edit.

/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "canonicalId".
 */
export type CanonicalId = string;
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "check".
 */
export type Check = string;
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "fact".
 */
export type Fact = string;
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "resultCode".
 */
export type ResultCode = string;
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "caseFragment".
 */
export type CaseFragment = Case | ShardedCase;
/**
 * @minItems 1
 *
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "exampleFragment".
 */
export type ExampleFragment = [Example, ...Example[]];

export interface ADR0006RuntimeOperationOracle {
  $schema: "./schema.json";
  schemaVersion: 1;
  adr: "ADR-0006";
  /**
   * @minItems 28
   * @maxItems 28
   */
  cases: [
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case,
    Case
  ];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "case".
 */
export interface Case {
  id: CanonicalId;
  requirement: number;
  /**
   * @minItems 2
   */
  examples: [Example, Example, ...Example[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "example".
 */
export interface Example {
  id: CanonicalId;
  check: Check;
  /**
   * @minItems 1
   */
  facts: [Fact, ...Fact[]];
  expected: {
    decision: "accept" | "reject";
    code: ResultCode;
  };
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "manifest".
 */
export interface Manifest {
  $schema: "./schema.json#/$defs/manifest";
  schemaVersion: 1;
  adr: "ADR-0006";
  catalog: "catalog.json";
  crossAxis: "cross-axis.json";
  /**
   * @minItems 28
   * @maxItems 28
   */
  cases: [
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    },
    {
      requirement: number;
      path: string;
    }
  ];
  expected: ValidationCounts;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "validationCounts".
 */
export interface ValidationCounts {
  caseCount: 28;
  exampleCount: 242;
  acceptedCount: 107;
  rejectedCount: 135;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "catalog".
 */
export interface Catalog {
  $schema: "./schema.json#/$defs/catalog";
  schemaVersion: 1;
  /**
   * @minItems 28
   * @maxItems 28
   */
  checks: [
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check,
    Check
  ];
  /**
   * @minItems 1
   */
  facts: [Fact, ...Fact[]];
  /**
   * @minItems 1
   */
  resultCodes: [ResultCode, ...ResultCode[]];
  /**
   * @minItems 1
   */
  acceptedResultCodes: [ResultCode, ...ResultCode[]];
  allowedFactsByCheck: {
    /**
     * @minItems 1
     */
    [k: string]: [Fact, ...Fact[]];
  };
  binaryRetentionFactRoles: {
    [k: string]: "command_intent" | "work_intent" | "evidence";
  };
  stateProductAxes: StateProductAxes;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "stateProductAxes".
 */
export interface StateProductAxes {
  /**
   * @minItems 1
   */
  dispatch: [string, ...string[]];
  /**
   * @minItems 1
   */
  admission: [string, ...string[]];
  /**
   * @minItems 1
   */
  output: [string, ...string[]];
  /**
   * @minItems 1
   */
  execution: [string, ...string[]];
  /**
   * @minItems 1
   */
  containment: [string, ...string[]];
  /**
   * @minItems 1
   */
  reconciliation: [string, ...string[]];
  /**
   * @minItems 1
   */
  manifest: [string, ...string[]];
  /**
   * @minItems 1
   */
  satisfaction: [string, ...string[]];
  /**
   * @minItems 1
   */
  effectResolution: [string, ...string[]];
  /**
   * @minItems 1
   */
  terminal: [string, ...string[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxis".
 */
export interface CrossAxis {
  $schema: "./schema.json#/$defs/crossAxis";
  schemaVersion: 1;
  requirement: 27;
  machineKind: "synthetic-verifier";
  initial: CrossAxisState;
  axes: CrossAxisAxes;
  /**
   * @minItems 1
   */
  transitions: [CrossAxisTransition, ...CrossAxisTransition[]];
  /**
   * @minItems 1
   */
  forbiddenTransitionFacts: [Fact, ...Fact[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisState".
 */
export interface CrossAxisState {
  [k: string]: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisAxes".
 */
export interface CrossAxisAxes {
  /**
   * @minItems 1
   */
  [k: string]: [string, ...string[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisTransition".
 */
export interface CrossAxisTransition {
  fact: Fact;
  /**
   * @minItems 1
   */
  targets: [CrossAxisTarget, ...CrossAxisTarget[]];
  requiredState?: {
    /**
     * @minItems 1
     */
    [k: string]: [string, ...string[]];
  };
  /**
   * @minItems 1
   */
  requiredFacts?: [Fact, ...Fact[]];
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "crossAxisTarget".
 */
export interface CrossAxisTarget {
  axis: string;
  from: string;
  to: string;
}
/**
 * This interface was referenced by `ADR0006RuntimeOperationOracle`'s JSON-Schema
 * via the `definition` "shardedCase".
 */
export interface ShardedCase {
  id: CanonicalId;
  requirement: number;
  /**
   * @minItems 1
   */
  exampleFragments: [string, ...string[]];
}
