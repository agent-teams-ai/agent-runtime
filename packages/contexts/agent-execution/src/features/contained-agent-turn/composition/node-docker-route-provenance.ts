import {canonicalJsonSha256} from "../adapters/outbound/host-custody/docker/engine/docker-canonical-json.js";
import {snapshotDockerEnginePolicy} from "../adapters/outbound/host-custody/docker/engine/docker-boundary-snapshot.js";
import type {DockerLinuxExclusiveRouteAdmissionInput} from "./docker-linux-exclusive-route-admission.js";
import type {DockerLinuxPostClaimDependencies} from "./docker-linux-post-claim-preparation.js";

type Route = Omit<DockerLinuxExclusiveRouteAdmissionInput, "binding">;
type Binding = DockerLinuxExclusiveRouteAdmissionInput["binding"];
export type NodeDockerRouteSubject = Pick<Binding,
  "operationId" | "attemptId" | "custodyId" | "executionGenerationId" | "authorityVectorDigest" | "hostBootId">;
type Policy = DockerLinuxPostClaimDependencies["enginePolicy"];
type Preparation = Pick<DockerLinuxPostClaimDependencies, "enginePolicy" | "engineIdentity" | "openLifecycle">;
const subjectKeys = ["operationId", "attemptId", "custodyId", "executionGenerationId", "authorityVectorDigest", "hostBootId"] as const;
const recipes = new WeakMap<object, Readonly<{subject: NodeDockerRouteSubject; preparation: Preparation; policy: string; isOpen(): boolean}>>();
const selected = new WeakSet<object>();

// Private feature-local provenance, never re-exported from an entrypoint. The
// route is an exact, frozen projection of one issued recipe, not a caller port.
export const nodeDockerRoutePolicy = (policy: Policy): string =>
  canonicalJsonSha256(snapshotDockerEnginePolicy({...policy, allowedNetworkName: "ar-identity-read-only"}));

export const retainNodeDockerRoute = (route: Route, subject: NodeDockerRouteSubject,
  preparation: Preparation, isOpen: () => boolean): void => {
  recipes.set(route, Object.freeze({subject: Object.freeze({...subject}), preparation, policy: nodeDockerRoutePolicy(preparation.enginePolicy), isOpen}));
};

export const selectNodeDockerRoute = (recipe: Readonly<{route: Route; preparation: Preparation}>, binding: Binding, policy: string,
  pins: Pick<Route, "nsenter" | "nft">): Readonly<{engine: Route["engine"]; isOpen(): boolean}> => {
  const route = recipe.route;
  const owner = recipes.get(route);
  if (owner === undefined || selected.has(route) || !owner.isOpen() || owner.policy !== policy ||
      recipe.preparation.openLifecycle !== owner.preparation.openLifecycle ||
      recipe.preparation.engineIdentity !== owner.preparation.engineIdentity ||
      nodeDockerRoutePolicy(recipe.preparation.enginePolicy) !== policy ||
      subjectKeys.some(key =>
        !owner.subject[key] || owner.subject[key] !== binding[key]) ||
      (["nsenter", "nft"] as const).some(key =>
        route[key].path !== pins[key].path || route[key].sha256 !== pins[key].sha256)) {
    throw new TypeError("Docker route recipe provenance mismatch");
  }
  selected.add(route);
  return Object.freeze({engine: route.engine, isOpen: owner.isOpen});
};
