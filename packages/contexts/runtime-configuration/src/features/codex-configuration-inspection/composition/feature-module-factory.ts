import { createInspectCodexConfiguration } from "../application/inspect-codex-configuration.js";
import type { CodexTomlParser } from "../application/ports/outbound/codex-toml-parser.js";
import type { ConfigurationSourceReader } from "../application/ports/outbound/configuration-source-reader.js";

export interface CodexConfigurationInspectionDependencies {
  readonly parser: CodexTomlParser;
  readonly sourceIdentityKey: Uint8Array;
  readonly sourceReader: ConfigurationSourceReader;
}

export const createCodexConfigurationInspectionFeature = (
  dependencies: CodexConfigurationInspectionDependencies,
) =>
  Object.freeze({
    inspectCodexConfiguration: createInspectCodexConfiguration(dependencies),
  });
