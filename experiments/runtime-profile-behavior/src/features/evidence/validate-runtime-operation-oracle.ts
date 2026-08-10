import { loadRuntimeOperationOracleAuthority } from "./runtime-operation-oracle-authority.ts";
import { createOracleEvaluator } from "./runtime-operation-oracle-evaluator.ts";
import {
  createStateProductEvaluator,
  type GeneratedState,
} from "./runtime-operation-state-product.ts";

export type {
  ADR0006RuntimeOperationOracle as RuntimeOperationOracle,
  Case as OracleCase,
  Check,
  Example as OracleExample,
  Fact,
  ResultCode,
} from "../../../spec/runtime-operation-oracle/generated/runtime-operation-oracle-types.generated.ts";
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
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  return createStateProductEvaluator(authority).evaluate();
};

export const validateRuntimeOperationOracle = async (
  repositoryRoot: string,
): Promise<RuntimeOperationOracleValidation> => {
  const authority = await loadRuntimeOperationOracleAuthority(repositoryRoot);
  const { manifest, oracle } = authority;
  const evaluateOracleExample = createOracleEvaluator(authority);
  const examples = oracle.cases.flatMap(({ examples: caseExamples }) => caseExamples);
  for (const example of examples) {
    const actual = evaluateOracleExample(example);
    if (JSON.stringify(actual) !== JSON.stringify(example.expected)) {
      throw new Error(
        `runtime-operation oracle: ${example.id} expected ${JSON.stringify(example.expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  const stateProduct = createStateProductEvaluator(authority).evaluate();
  return {
    ...manifest.expected,
    stateProduct,
  };
};

if (process.argv[1]?.endsWith("validate-runtime-operation-oracle.ts")) {
  const validation = await validateRuntimeOperationOracle(process.cwd());
  console.log(JSON.stringify(validation));
}
