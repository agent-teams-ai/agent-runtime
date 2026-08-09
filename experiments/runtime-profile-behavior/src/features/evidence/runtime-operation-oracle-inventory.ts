import { BINARY_RETENTION_AUTHORIZATION_BOUNDARY_EXAMPLES } from "./runtime-operation-oracle-inventory-authorization-boundary.ts";
import { RUNTIME_OPERATION_ORACLE_CORE_CASES } from "./runtime-operation-oracle-inventory-core.ts";
import { RUNTIME_OPERATION_ORACLE_CROSS_AXIS_CASES } from "./runtime-operation-oracle-inventory-cross-axis.ts";
import { BINARY_RETENTION_DELETION_AND_ACCEPTANCE_EXAMPLES } from "./runtime-operation-oracle-inventory-deletion-and-acceptance.ts";
import { BINARY_RETENTION_OBLIGATION_LIFECYCLE_EXAMPLES } from "./runtime-operation-oracle-inventory-obligation-lifecycle.ts";
import { BINARY_RETENTION_RETENTION_CORE_EXAMPLES } from "./runtime-operation-oracle-inventory-retention-core.ts";

export const RUNTIME_OPERATION_ORACLE_INVENTORY = [
  ...RUNTIME_OPERATION_ORACLE_CORE_CASES,
  ...RUNTIME_OPERATION_ORACLE_CROSS_AXIS_CASES,
  {
    caseId: "binary-revision-semantic-retention",
    examples: [
      ...BINARY_RETENTION_RETENTION_CORE_EXAMPLES,
      ...BINARY_RETENTION_DELETION_AND_ACCEPTANCE_EXAMPLES,
      ...BINARY_RETENTION_OBLIGATION_LIFECYCLE_EXAMPLES,
      ...BINARY_RETENTION_AUTHORIZATION_BOUNDARY_EXAMPLES,
    ],
  },
] as const;
