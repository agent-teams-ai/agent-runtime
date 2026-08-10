import { loadRuntimeOperationOracleAuthority } from "./runtime-operation-oracle-authority.ts";
import { evaluateOracleExample } from "./runtime-operation-oracle-evaluator.ts";
import {
  evaluateGeneratedAxisProducts as evaluateStateProduct,
  generatedStateIsValid,
  type GeneratedState,
  type StateProductAxes,
} from "./runtime-operation-state-product.ts";

export {
  ALLOWED_FACTS_BY_CHECK,
} from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-catalog.generated.ts";
export {
  GENERATED_AXES,
  ORACLE_ACCEPTED_RESULT_CODES,
  ORACLE_CHECKS,
  ORACLE_FACTS,
  ORACLE_RESULT_CODES,
} from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-catalog.generated.ts";
export type {
  ADR0006RuntimeOperationOracle as RuntimeOperationOracle,
  Case as OracleCase,
  Check,
  Example as OracleExample,
  Fact,
  ResultCode,
} from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";
export { evaluateOracleExample, generatedStateIsValid };
export type { GeneratedState };

export type RuntimeOperationOracleValidation = {
  caseCount: number;
  exampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  stateProduct: {
    total: number;
    valid: number;
    invalid: number;
  };
};

export const evaluateGeneratedAxisProducts = async (
  repositoryRoot = process.cwd(),
): Promise<RuntimeOperationOracleValidation["stateProduct"]> => {
  const { catalog } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  return evaluateStateProduct(catalog.stateProductAxes as StateProductAxes);
};

export const validateRuntimeOperationOracle = async (
  repositoryRoot: string,
): Promise<RuntimeOperationOracleValidation> => {
  const { manifest, catalog, oracle } = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const examples = oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  for (const example of examples) {
    const actual = evaluateOracleExample(example);
    if (JSON.stringify(actual) !== JSON.stringify(example.expected)) {
      throw new Error(
        `runtime-operation oracle: ${example.id} expected ${JSON.stringify(example.expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  const stateProduct = evaluateStateProduct(catalog.stateProductAxes as StateProductAxes);
  return {
    ...manifest.expected,
    stateProduct,
  };
};

if (process.argv[1]?.endsWith("validate-runtime-operation-oracle.ts")) {
  const validation = await validateRuntimeOperationOracle(process.cwd());
  console.log(JSON.stringify(validation));
}
