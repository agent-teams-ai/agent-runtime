import { replayDockerCustodyBytes } from "./docker-custody-journal-codec.js";
import { DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS } from "./docker-custody-journal-types.js";
import { parseStrictJson } from "../engine/strict-json.js";
import type { DockerEgressLegacyDiagnostic, DockerEgressLegacyV2Result } from "./docker-egress-journal-types.js";

const result = (diagnostic: DockerEgressLegacyDiagnostic, quarantineRequired: boolean): DockerEgressLegacyV2Result =>
  Object.freeze({ diagnostic, quarantineRequired, executionAuthority: null, cleanupIdentity: null });

/**
 * V2 has its original, immutable byte/record/count bounds. It is parsed only
 * as read-only legacy disposition; no V2 field is returned as V3 authority.
 */
export const classifyDockerEgressLegacyV2 = (bytes: Uint8Array): DockerEgressLegacyV2Result => {
  const limits = DEFAULT_DOCKER_CUSTODY_JOURNAL_LIMITS;
  if (bytes.byteLength === 0) { return result("legacy_empty", false); }
  if (bytes.byteLength > limits.maxJournalBytes) { return result("legacy_oversized", true); }
  try {
    // Validate every complete record with the duplicate-key and fatal UTF-8
    // parser before the legacy codec is allowed to inspect it.
    let start = 0; let count = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) { continue; }
      const line = bytes.subarray(start, index);
      if (line.byteLength === 0 || line.byteLength + 1 > limits.maxRecordBytes || ++count > limits.maxRecordsPerJournal) {
        return result("legacy_corrupt", true);
      }
      parseStrictJson(line); start = index + 1;
    }
    const replay = replayDockerCustodyBytes(bytes, limits);
    if (replay.tail === "partial") { return result("legacy_partial_tail", true); }
    const last = replay.records.at(-1);
    if (last === undefined || (last.state === "prepared" && replay.records.length === 1) ||
        (last.state === "closed" && last.evidence.status === "proved")) { return result("legacy_empty", false); }
    return result("legacy_populated_without_cleanup_identity", true);
  } catch { return result("legacy_corrupt", true); }
};
