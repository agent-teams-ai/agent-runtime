import {
  HostCustodyFingerprintConflictError,
  type ContainedTurnCustodyHandle,
  type HostCustodyReservationInput,
  type ProviderProcessCustodyPort,
} from "./custodied-provider-process.js";
import type { CustodyTombstone, LiveCustody } from "./node-provider-process-custody-state.js";

import { canonicalJson, inputIdentity, sha256 } from "./host-custody-launch.js";
import { assertInertHostLaunchData, snapshotHostCustodyLaunchPlan } from "./host-custody-launch-plan-snapshot.js";
import { hostLaunchFinalizationRecipe } from "./host-custody-finalizable-plan.js";

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
  if ((existing.launchBinding?.reservation?.fingerprint ?? existing.fingerprint)?.fingerprintSha256 !== candidate.fingerprint.fingerprintSha256) {
    throw new HostCustodyFingerprintConflictError("Host Custody attempt fingerprint conflict");
  }
  return Object.freeze({ custodyRef: existing.custodyRef });
};

/** Replay is input identity, never re-resolution or a final execution identity. */
export const privateReservationIdentity = (input: HostCustodyReservationInput): string =>
  sha256(canonicalJson([inputIdentity(input), input.workspaceAuthority.canonicalPath, input.workspaceAuthority.descriptorPath,
    input.workspaceAuthority.identity.dev.toString(), input.workspaceAuthority.identity.ino.toString(),
    input.workspaceAuthority.identity.mountId]));

export const snapshotPrivateReservationReplayInput = (input: HostCustodyReservationInput): HostCustodyReservationInput => {
  assertInertHostLaunchData(input);
  assertInertHostLaunchData(input.providerBinding);
  assertInertHostLaunchData(input.workspaceAuthority);
  assertInertHostLaunchData(input.workspaceAuthority.identity);
  const keys = ["attemptId", "intentMode", "operationId", "providerBinding", "workspaceRef", "launchPlan", "workspaceAuthority"];
  const bindingKeys = ["provider", "adapterRevision", "binaryRevision", "capabilityManifestRevision", "credentialBindingDigest", "providerRouteRef"];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) ||
      [input.attemptId, input.operationId, input.workspaceRef].some(value => typeof value !== "string") ||
      !["analysis", "workspace-write"].includes(input.intentMode) ||
      Object.keys(input.providerBinding).length !== bindingKeys.length ||
      bindingKeys.some(key => typeof input.providerBinding[key as keyof typeof input.providerBinding] !== "string")) {
    throw new TypeError("Host Custody private reservation inputs rejected");
  }
  const authority = input.workspaceAuthority;
  if (typeof authority.canonicalPath !== "string" || typeof authority.descriptorPath !== "string" ||
      typeof authority.identity.dev !== "bigint" || typeof authority.identity.ino !== "bigint" ||
      typeof authority.identity.mountId !== "string") {throw new TypeError("Host Custody workspace identity rejected");}
  return Object.freeze({...input, launchPlan: snapshotHostCustodyLaunchPlan(input.launchPlan),
    providerBinding: Object.freeze({...input.providerBinding}),
    workspaceAuthority: Object.freeze({...input.workspaceAuthority,
      identity: Object.freeze({...input.workspaceAuthority.identity})}),
  });
};

export const assertPrivateReservationReplay = (
  prior: LiveCustody | CustodyTombstone, input: HostCustodyReservationInput,
): void => {
  const original = prior.privateReservationPlan;
  if (original === undefined || prior.inputIdentitySha256 !== privateReservationIdentity(input) ||
      hostLaunchFinalizationRecipe(original) !== undefined && original !== input.launchPlan ||
      canonicalJson(original) !== canonicalJson(input.launchPlan)) {
    throw new HostCustodyFingerprintConflictError("Host Custody private reservation fingerprint conflict");
  }
};
