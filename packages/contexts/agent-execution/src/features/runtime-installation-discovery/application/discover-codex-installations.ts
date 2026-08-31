import type {
  DiscoverCodexInstallations,
  DiscoverCodexInstallationsResult,
  InstallationAliasObservation,
  CodexInstallationDiagnostic,
} from "./models/installation-observation.js";
import type { ExecutableFileObserver } from "./ports/outbound/executable-file-observation.js";
import type { StableIdentityHasher } from "./ports/outbound/stable-identity-hashing.js";

const diagnosticCode = {
  denied: "candidate_denied",
  invalid: "candidate_invalid",
  unstable: "candidate_unstable",
  unreadable: "candidate_unreadable",
} as const;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const createDiscoverCodexInstallations = (
  fileObserver: ExecutableFileObserver,
  identityHasher: StableIdentityHasher,
): DiscoverCodexInstallations => ({
  async execute(input, options): Promise<DiscoverCodexInstallationsResult> {
    options?.signal?.throwIfAborted();
    if (input.observationEpoch.length === 0) {
      throw new TypeError("observationEpoch must not be empty");
    }

    const grouped = new Map<string, InstallationAliasObservation[]>();
    const diagnostics: CodexInstallationDiagnostic[] = [];
    const candidates = [...input.candidates].toSorted((left, right) =>
      compareText(left.displayPath, right.displayPath),
    );

    for (const candidate of candidates) {
      options?.signal?.throwIfAborted();
      const observation = await fileObserver.observe({
        absolutePath: candidate.absolutePath,
        authorizedFileIdentity: candidate.authorizedFileIdentity,
        custodyBoundary: candidate.custodyRoot,
        expectedCanonicalPath: candidate.canonicalPath,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (observation.kind === "missing") {
        if (candidate.required) {
          diagnostics.push({
            candidate: candidate.displayPath,
            code: "candidate_invalid",
          });
        }
        continue;
      }
      if (observation.kind !== "found") {
        diagnostics.push({
          candidate: candidate.displayPath,
          code: diagnosticCode[observation.kind],
        });
        continue;
      }

      const aliases = grouped.get(observation.identity) ?? [];
      aliases.push({ displayPath: candidate.displayPath, source: candidate.source });
      grouped.set(observation.identity, aliases);
    }

    const installations = [...grouped.entries()]
      .map(([identity, aliases]) => ({
        aliases: aliases.toSorted((left, right) =>
          compareText(left.displayPath, right.displayPath),
        ),
        installationRef: `codex-installation:${identityHasher.digest(identity)}`,
        status: "found_unverified" as const,
      }))
      .toSorted((left, right) =>
        compareText(left.installationRef, right.installationRef),
      );

    return {
      diagnostics: diagnostics.toSorted((left, right) =>
        compareText(
          `${left.code}:${left.candidate}`,
          `${right.code}:${right.candidate}`,
        ),
      ),
      installations,
      observationEpoch: input.observationEpoch,
    };
  },
});
