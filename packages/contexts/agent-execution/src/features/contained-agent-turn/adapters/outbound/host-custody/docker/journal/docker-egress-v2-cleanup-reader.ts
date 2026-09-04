import { parseStrictJson } from "../engine/strict-json.js";
import { replayDockerCustodyBytes } from "./docker-custody-journal-codec.js";
import { DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS } from "./docker-custody-journal-types.js";
import type { DockerEgressJournalLimits, DockerEgressLegacyDiagnostic } from "./docker-egress-journal-types.js";

export interface DockerEgressLegacyV2Result {
  readonly diagnostic: DockerEgressLegacyDiagnostic;
  readonly quarantineRequired: boolean;
  /** Deliberately always null: V2 cannot grant execution or cleanup authority to V3. */
  readonly executionAuthority: null;
  readonly cleanupIdentity: null;
}

const boundedResult = (
  diagnostic: DockerEgressLegacyDiagnostic,
  quarantineRequired: boolean,
): DockerEgressLegacyV2Result => Object.freeze({
  diagnostic, quarantineRequired, executionAuthority: null, cleanupIdentity: null,
});

export const dockerJournalWireVersion = (bytes: Uint8Array, maxRecordBytes: number): number | undefined => {
  const newline = bytes.indexOf(0x0a);
  const end = newline < 0 ? bytes.byteLength : newline;
  if (end === 0 || end + (newline < 0 ? 0 : 1) > maxRecordBytes) { return; }
  try {
    const parsed = parseStrictJson(bytes.subarray(0, end));
    if (parsed === null || typeof parsed !== "object") { return; }
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "version");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "number"
      ? descriptor.value
      : undefined;
  } catch { return; }
};

/**
 * Reads V2 only to decide conservative cleanup disposition. It intentionally
 * returns neither a V3 subject nor any request/materialization authority.
 */
export const classifyDockerEgressLegacyV2 = (
  bytes: Uint8Array,
  limits: DockerEgressJournalLimits,
): DockerEgressLegacyV2Result => {
  if (bytes.byteLength === 0) { return boundedResult("legacy_empty", false); }
  if (bytes.byteLength > limits.maxJournalBytes) { return boundedResult("legacy_oversized", true); }
  try {
    const replay = replayDockerCustodyBytes(bytes, {
      ...DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS,
      maxJournalBytes: limits.maxJournalBytes,
      maxRecordBytes: limits.maxRecordBytes,
      maxRecordsPerJournal: limits.maxRecordsPerJournal,
      maxRestartScanBytes: limits.maxRestartScanBytes,
    });
    if (replay.tail === "partial") { return boundedResult("legacy_partial_tail", true); }
    const last = replay.records.at(-1);
    if (last === undefined || (last.state === "prepared" && replay.records.length === 1)) {
      return boundedResult("legacy_empty", false);
    }
    // A debt-free V2 close proves its one provider container was removed, but
    // remains terminal cleanup evidence only; it cannot become V3 authority.
    if (last.state === "closed" && last.evidence.status === "proved") {
      return boundedResult("legacy_empty", false);
    }
    // V2 never stored the exact network/broker/socket/rule identities needed
    // for safe V3 cleanup. Guessing or synthesizing them would broaden authority.
    return boundedResult("legacy_populated_without_cleanup_identity", true);
  } catch {
    return boundedResult("legacy_corrupt", true);
  }
};
