import {
  HostCustodyFingerprintConflictError,
  type ContainedTurnCustodyHandle,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import type { CustodyTombstone, LiveCustody } from "./node-provider-process-custody-state.js";

interface CandidateFingerprint {
  readonly fingerprint: { readonly fingerprintSha256: string };
}

export const replayCustody = async (
  input: Parameters<ProviderProcessCustodyPort["open"]>[0],
  inputIdentitySha256: string,
  tombstone: CustodyTombstone | undefined,
  existing: LiveCustody | undefined,
  resolveCandidate: () => Promise<CandidateFingerprint>,
): Promise<ContainedTurnCustodyHandle | undefined> => {
  if (tombstone !== undefined) {
    if (tombstone.inputIdentitySha256 !== inputIdentitySha256) {
      throw new HostCustodyFingerprintConflictError("Host Custody attempt fingerprint conflict");
    }
    return Object.freeze({ custodyRef: tombstone.custodyRef });
  }
  if (existing === undefined) {return undefined;}
  if (existing.inputIdentitySha256 !== inputIdentitySha256) {
    throw new HostCustodyFingerprintConflictError("Host Custody attempt fingerprint conflict");
  }
  await existing.opening;
  const candidate = await resolveCandidate();
  if (existing.fingerprint?.fingerprintSha256 !== candidate.fingerprint.fingerprintSha256) {
    throw new HostCustodyFingerprintConflictError("Host Custody attempt fingerprint conflict");
  }
  return Object.freeze({ custodyRef: existing.custodyRef });
};
