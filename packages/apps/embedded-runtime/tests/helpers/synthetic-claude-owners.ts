import {
  createNodeExecutableFileObserver,
  createRuntimeInstallationDiscoveryFeature,
} from "@agent-teams/agent-execution/composition";
import {
  createClaudeCodeConfigurationInspectionFeature,
  createClaudeCodeConfigurationSemanticClassifierV2,
  createClaudeCodeConfigurationSourceReaderAdapter,
  createNodeConfigurationSourceReader,
  createStrictClaudeCodeJsonParser,
} from "@agent-teams/runtime-configuration/composition";
import {
  createNodePathCanonicalizer,
  createSetupInspectionAuthorizationFeature,
} from "@agent-teams/runtime-security/composition";

import { createClaudeCodeSetupInspectionPlanner } from "../../dist/composition.js";

const syntheticSystemPath = (path: string): boolean =>
  path === "/opt/homebrew" || path.startsWith("/opt/homebrew/") ||
  path === "/usr/local" || path.startsWith("/usr/local/");

export const createSyntheticClaudeOwners = (systemInstallations = false) => {
  const nodeCanonicalizer = createNodePathCanonicalizer();
  const security = createSetupInspectionAuthorizationFeature({
    pathCanonicalizer: {
      async canonicalize(path, options) {
        options?.signal?.throwIfAborted();
        if (systemInstallations &&
          (path === "/opt/homebrew/bin/claude" || path === "/usr/local/bin/claude")) {
          return {
            absolutePath: path, canonicalLocationPath: path, exists: true,
            fileIdentity: `synthetic-system:${path}`, isFile: true, linkCount: 1,
          };
        }
        return syntheticSystemPath(path)
          ? { absolutePath: path, canonicalLocationPath: path, exists: false }
          : nodeCanonicalizer.canonicalize(path, options);
      },
    },
  });
  const nodeExecutableObserver = createNodeExecutableFileObserver();
  const execution = createRuntimeInstallationDiscoveryFeature({
    executableFileObserver: {
      async observe(request) {
        request.signal?.throwIfAborted();
        const path = request.absolutePath;
        if (systemInstallations &&
          (path === "/opt/homebrew/bin/claude" || path === "/usr/local/bin/claude")) {
          return { identity: `system-installation:${path}`, kind: "found" as const };
        }
        return syntheticSystemPath(path)
          ? { kind: "missing" as const }
          : nodeExecutableObserver.observe(request);
      },
    },
  });
  const configuration = createClaudeCodeConfigurationInspectionFeature({
    parser: createStrictClaudeCodeJsonParser(),
    semanticClassifier: createClaudeCodeConfigurationSemanticClassifierV2(),
    sourceIdentityKey: new Uint8Array(32).fill(7),
    sourceReader: createClaudeCodeConfigurationSourceReaderAdapter(createNodeConfigurationSourceReader()),
  });
  return {
    authorizeClaudeCodeSetupInspection: security.authorizeClaudeCodeSetupInspection,
    discoverClaudeCodeInstallations: execution.discoverClaudeCodeInstallations,
    inspectClaudeCodeConfiguration: configuration,
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("darwin"),
  };
};
