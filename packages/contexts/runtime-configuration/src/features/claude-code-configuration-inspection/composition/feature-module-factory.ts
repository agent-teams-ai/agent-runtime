import type { InspectClaudeCodeConfiguration } from "../contracts/claude-code-configuration-inspection.js";
import { createInspectClaudeCodeConfiguration } from "../application/inspect-claude-code-configuration.js";
import type { ClaudeCodeJsonParser } from "../application/ports/outbound/claude-code-json-parser.js";
import type { ClaudeCodeConfigurationSemanticClassifier } from "../application/ports/outbound/claude-code-configuration-semantic-classifier.js";
import type { ClaudeCodeConfigurationSourceReader } from "../application/ports/outbound/claude-code-configuration-source-reader.js";

export interface ClaudeCodeConfigurationInspectionDependencies {
  readonly parser: ClaudeCodeJsonParser;
  readonly semanticClassifier: ClaudeCodeConfigurationSemanticClassifier;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ClaudeCodeConfigurationSourceReader;
}

export const createClaudeCodeConfigurationInspectionFeature = (
  dependencies: ClaudeCodeConfigurationInspectionDependencies,
): InspectClaudeCodeConfiguration => createInspectClaudeCodeConfiguration(dependencies);
