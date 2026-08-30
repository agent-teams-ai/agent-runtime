import { createStaticProviderAccessBindingRepository } from "./features/contained-turn-access/adapters/outbound/static-provider-access-binding-repository.js";
import { createContainedTurnProviderAccessFeature } from "./features/contained-turn-access/composition/feature-module-factory.js";
import type {
  ConsumeForDispatchInput,
  ContainedTurnDispatchConsumptionV1,
  ContainedTurnProviderAccessFeatureApi,
  ProviderAccessProvider,
  ProviderAccessScope,
} from "./index.js";
import { createContainedTurnDispatchConsumptionV1 } from "./features/contained-turn-access/composition/dispatch-consumption-v1-factory.js";
import { createInMemoryDispatchConsumptionRepository } from "./features/contained-turn-access/adapters/outbound/in-memory-dispatch-consumption-repository.js";
import { createSha256DispatchConsumptionDigest } from "./features/contained-turn-access/adapters/outbound/sha256-dispatch-consumption-digest.js";
import {
  claimBindingDigestPayload, requestDigestPayload, type DispatchBindingHead, type DispatchConsumeCommand,
} from "./features/contained-turn-access/domain/dispatch-consumption.js";

/** Non-secret authority seed for deterministic same-application composition and tests. */
export interface StaticAvailableProviderAccessAuthority {
  readonly accessRef: string;
  readonly availability?: "available" | "unavailable";
  /** Authority-issued opaque digest over non-secret owner facts. */
  readonly credentialBindingDigest: string;
  readonly credentialBindingRef: string;
  readonly credentialGeneration: number;
  readonly kind: "binding";
  readonly projectId: string;
  readonly provider: ProviderAccessProvider;
  readonly providerAccountRef: string;
  readonly providerRouteRef: string;
  readonly revision: number;
  readonly revocation?: "active" | "revoked";
  readonly tenantId: string;
}

/** Fail-closed static observation for one exact qualified lookup. */
export interface StaticIndeterminateProviderAccessAuthority {
  readonly kind: "indeterminate";
  readonly provider: ProviderAccessProvider;
  readonly scope: ProviderAccessScope;
}

export type StaticProviderAccessAuthority =
  | StaticAvailableProviderAccessAuthority
  | StaticIndeterminateProviderAccessAuthority;

/** Narrow deterministic composition entrypoint; persistence ports, records, and adapters remain private. */
export const createStaticContainedTurnProviderAccessFeature = (
  authorities: readonly StaticProviderAccessAuthority[],
): ContainedTurnProviderAccessFeatureApi => createContainedTurnProviderAccessFeature({
  bindingRepository: createStaticProviderAccessBindingRepository(authorities),
});

/** Non-secret exact owner head for the deterministic in-memory dispatch-consumption adapter. */
export interface InMemoryDispatchBindingSeed {
  readonly acceptedAuthorityDigest: string; readonly accessRef: string; readonly authorityHeadDigest: string;
  readonly availability?: "available" | "unavailable"; readonly bindingDigest: string; readonly bindingRevision: number;
  readonly claimBeforeControlTime: number; readonly credentialBindingDigest: string; readonly credentialBindingRef: string;
  readonly credentialGeneration: number; readonly opaqueOwnerEvidenceRef: string; readonly projectId: string;
  readonly provider: ProviderAccessProvider; readonly providerAccountRef: string; readonly providerRouteRef: string;
  readonly revocation?: "active" | "revoked"; readonly scopeDigest: string; readonly tenantId: string;
  readonly expiresAtControlTime: number;
}

export interface InMemoryDispatchConsumptionHarness {
  readonly access: ContainedTurnDispatchConsumptionV1;
  readonly control: Readonly<{
    advanceControlTime(value: number): void;
    observeOwnerState(input: { readonly provider: ProviderAccessProvider; readonly scopeDigest: string }):
      "absent" | "consumed_pending" | "claim_committed" | "abandoned_without_claim" | undefined;
    replaceBindingHead(seed: InMemoryDispatchBindingSeed): void;
  }>;
}

const seedToHead = (seed: InMemoryDispatchBindingSeed): DispatchBindingHead => ({
  ...seed, availability: seed.availability ?? "available", revocation: seed.revocation ?? "active",
});

export const createInMemoryContainedTurnDispatchConsumptionV1 = (input: {
  readonly bindings: readonly InMemoryDispatchBindingSeed[];
  readonly initialControlTime: number;
}): InMemoryDispatchConsumptionHarness => {
  if (!Number.isSafeInteger(input.initialControlTime) || input.initialControlTime < 1) {
    throw new TypeError("initial control time must be a positive safe integer");
  }
  let controlTime = input.initialControlTime;
  const { control, repository } = createInMemoryDispatchConsumptionRepository(input.bindings.map(seedToHead));
  const digest = createSha256DispatchConsumptionDigest();
  return Object.freeze({
    access: createContainedTurnDispatchConsumptionV1({ clock: { now: () => controlTime }, digest, repository }),
    control: Object.freeze({
      advanceControlTime(value: number) {
        if (!Number.isSafeInteger(value) || value < controlTime) throw new TypeError("control time must advance monotonically");
        controlTime = value;
      },
      observeOwnerState: control.observeOwnerState,
      replaceBindingHead(seed: InMemoryDispatchBindingSeed) { control.replaceBindingHead(seedToHead(seed)); },
    }),
  });
};

/** Produces the exact V1 claim-binding and request digests without exposing digest infrastructure. */
export const createDispatchConsumptionRequestDigests = async (
  input: Omit<ConsumeForDispatchInput, "claimBindingDigest" | "requestDigest">,
): Promise<Readonly<{ claimBindingDigest: string; requestDigest: string }>> => {
  const digest = createSha256DispatchConsumptionDigest();
  const command = { ...input, claimBindingDigest: "pending", requestDigest: "pending" } as DispatchConsumeCommand;
  const claimBindingDigest = await digest.digest(claimBindingDigestPayload(command));
  const { requestDigest: _requestDigest, ...unsigned } = { ...command, claimBindingDigest };
  return Object.freeze({ claimBindingDigest, requestDigest: await digest.digest(requestDigestPayload(unsigned)) });
};
