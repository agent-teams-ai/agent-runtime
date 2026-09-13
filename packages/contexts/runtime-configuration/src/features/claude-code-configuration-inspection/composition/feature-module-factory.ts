import { assertClaudeCodeVocabularyParity } from "../adapters/inbound/claude-code-vocabulary-parity.js";
import { createClaudeCodeConfigurationInspectionV1 } from "../adapters/inbound/claude-code-configuration-inspection-v1.js";
import type { ConfigurationDigest } from "../application/ports/outbound/configuration-digest.js";
import type { InspectClaudeCodeConfiguration } from "../contracts/claude-code-configuration-inspection.js";
import { createInspectClaudeCodeConfiguration } from "../application/inspect-claude-code-configuration.js";
import type { ClaudeCodeJsonParser } from "../application/ports/outbound/claude-code-json-parser.js";
import type { ClaudeCodeConfigurationSemanticClassifier } from "../application/ports/outbound/claude-code-configuration-semantic-classifier.js";
import type { ClaudeCodeConfigurationSourceReader } from "../application/ports/outbound/claude-code-configuration-source-reader.js";

export interface ClaudeCodeConfigurationInspectionDependencies {
  readonly digest: ConfigurationDigest;
  readonly parser: ClaudeCodeJsonParser;
  readonly semanticClassifier: ClaudeCodeConfigurationSemanticClassifier;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ClaudeCodeConfigurationSourceReader;
}

export const createClaudeCodeConfigurationInspectionFeature = (
  dependencies: ClaudeCodeConfigurationInspectionDependencies,
): InspectClaudeCodeConfiguration => {
  // Refuse to construct a feature whose published vocabulary and enforced
  // vocabulary disagree: the two declarations exist because no layer may hold
  // both, so the only honest moment to check them is before anything is built.
  assertClaudeCodeVocabularyParity();
  return createClaudeCodeConfigurationInspectionV1(
    createInspectClaudeCodeConfiguration(dependencies),
  );
};
