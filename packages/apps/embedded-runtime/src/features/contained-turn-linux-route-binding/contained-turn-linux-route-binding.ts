import { types } from "node:util";
import { snapshotRouteSelectionCurrent } from "@agent-teams/provider-access/composition";
import type { DockerLinuxExclusiveRouteAdmissionInput } from "@agent-teams/agent-execution/composition";

type RouteBinding = DockerLinuxExclusiveRouteAdmissionInput["binding"];

/** Operation and product facts the trusted composition root already owns. None
 * of them is a Provider Access fact, and none may come from the environment,
 * a canary report or the provider process. */
export type ContainedTurnLinuxRouteCampaign = Readonly<{
  operationId: string;
  attemptId: string;
  custodyId: string;
  hostBootId: string;
  executionGenerationId: string;
  authorityVectorDigest: string;
  /** 40-hex product source revision from trusted deployment composition. */
  sourceRevision: string;
  adapterRevision: string;
  binaryRevision: string;
  capabilityManifestRevision: string;
}>;

const CAMPAIGN_KEYS = ["operationId", "attemptId", "custodyId", "hostBootId", "executionGenerationId",
  "authorityVectorDigest", "sourceRevision", "adapterRevision", "binaryRevision", "capabilityManifestRevision"] as const;
const invalid = (): TypeError => new TypeError("Invalid contained turn Linux route binding");

const campaignFacts = (value: ContainedTurnLinuxRouteCampaign): ContainedTurnLinuxRouteCampaign => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== CAMPAIGN_KEYS.length) {throw invalid();}
  const fields = Object.getOwnPropertyDescriptors(value);
  const facts: Record<string, string> = Object.create(null);
  for (const key of CAMPAIGN_KEYS) {
    const field = fields[key];
    if (field === undefined || !("value" in field) || !field.enumerable ||
        typeof field.value !== "string" || field.value.length < 1 || field.value.length > 256 ||
        /[\p{Cc}\s]/u.test(field.value)) {throw invalid();}
    facts[key] = field.value;
  }
  return Object.freeze(facts) as unknown as ContainedTurnLinuxRouteCampaign;
};

/**
 * Projects one Provider Access route endorsement and the trusted campaign facts
 * into the exact 21-field binding the Linux exclusive route owner requires.
 *
 * Six of those fields are Provider Access's own — the access, account and route
 * refs, the binding revision, and the opaque credential binding digest and
 * generation. They are transported here, never derived: PA validates and detaches
 * the endorsement, including its availability, revocation, route authority digest
 * and generation, before any of it can reach a kernel route. This projection
 * approves no policy, reads no database, renders no credential and installs
 * nothing; the route owner re-validates every field it is handed.
 */
export const createContainedTurnLinuxRouteBinding = async (input: Readonly<{
  campaign: ContainedTurnLinuxRouteCampaign;
  /** The PA route selection owner's current endorsement, exactly as PA returns it. */
  current: unknown;
  /** The provider this operation was accepted for; PA's binding must agree. */
  provider: "claude" | "codex";
}>): Promise<RouteBinding> => {
  const campaign = campaignFacts(input.campaign);
  const endorsement = await snapshotRouteSelectionCurrent(input.current);
  const binding = endorsement.binding;
  if (binding.provider !== input.provider || endorsement.descriptor.provider !== input.provider) {throw invalid();}
  return Object.freeze({
    tenantId: binding.tenantId,
    projectId: binding.projectId,
    scopeDigest: binding.scopeDigest,
    operationId: campaign.operationId,
    attemptId: campaign.attemptId,
    custodyId: campaign.custodyId,
    sourceRevision: campaign.sourceRevision,
    binaryRevision: campaign.binaryRevision,
    adapterRevision: campaign.adapterRevision,
    capabilityManifestRevision: campaign.capabilityManifestRevision,
    authorityVectorDigest: campaign.authorityVectorDigest,
    hostBootId: campaign.hostBootId,
    executionGenerationId: campaign.executionGenerationId,
    providerRouteRef: binding.providerRouteRef,
    providerAccountRef: binding.providerAccountRef,
    accessRef: binding.accessRef,
    // The route's own identity revision, not a copy of the binding revision:
    // it changes whenever any endorsed route fact changes.
    routeRevision: endorsement.routeAuthorityDigest,
    bindingRevision: binding.bindingRevision,
    credentialBindingRef: binding.credentialBindingRef,
    credentialBindingDigest: binding.credentialBindingDigest,
    credentialGeneration: binding.credentialGeneration,
  });
};
