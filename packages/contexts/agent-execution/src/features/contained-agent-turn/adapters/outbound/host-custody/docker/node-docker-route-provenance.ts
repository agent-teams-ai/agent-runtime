import {types} from "node:util";
import {canonicalJsonSha256} from "./engine/docker-engine-composition.js";
import {snapshotDockerEngineCall, snapshotDockerEnginePolicy} from "./engine/docker-engine-composition.js";
import type {openNodeLinuxExclusiveRoute} from "./node-linux-exclusive-route.js";
import type {LinuxExclusiveRouteBinding} from "./linux-exclusive-route-owner.js";
import type {DockerEnginePolicy, DockerEngineCall} from "./engine/docker-engine-port.js";
import type {DockerHostCustodyLifecycle} from "./docker-host-custody-lifecycle.js";
import type {dockerHostCustodyAttemptKey} from "./docker-host-custody-lifecycle-guards.js";

type Route = Pick<Parameters<typeof openNodeLinuxExclusiveRoute>[0], "engine" | "nsenter" | "nft">;
type Binding = LinuxExclusiveRouteBinding;
export type NodeDockerRouteSubject = Pick<Binding,
  "operationId" | "attemptId" | "custodyId" | "executionGenerationId" | "authorityVectorDigest" | "hostBootId">;
type Policy = Omit<DockerEnginePolicy, "allowedNetworkName">;
type Preparation = Readonly<{
  enginePolicy: Policy;
  engineIdentity(call: DockerEngineCall): Promise<Parameters<typeof dockerHostCustodyAttemptKey>[2]>;
  openLifecycle(policy: DockerEnginePolicy): DockerHostCustodyLifecycle;
}>;
export const createNodeDockerRouteProvenance = (custodyDataRecord: <Value extends object>(value: Value) => Value) => {
// Configuration is copied before any owner callback or provenance comparison.
// Only contract ports borrow receivers; data callbacks keep their exact identity.
const portKeys: Readonly<Record<string, readonly string[]>> = {
  engineClient: ["buffered", "endpointIdentity", "stream", "hijack"],
  "resources.localCut.clock": ["read", "within"],
  "resources.consumption": ["prepare"],
};
const snapshotPort = <T extends object>(value: T, keys: readonly string[]): T => {
  const result: Record<string, unknown> = {};
  // Reject own accessors even on borrowed class instances.
  custodyDataRecord(value);
  for (const key of keys) {
    let owner: object | null = value;
    let field: PropertyDescriptor | undefined;
    while (owner !== null && field === undefined) {
      if (types.isProxy(owner)) {throw new TypeError("Docker recipe port unavailable");}
      field = Object.getOwnPropertyDescriptor(owner, key);
      owner = Object.getPrototypeOf(owner);
    }
    if (field === undefined && key === "hijack") {continue;}
    if (field === undefined || !("value" in field) || typeof field.value !== "function" || types.isProxy(field.value)) {
      throw new TypeError("Docker recipe port unavailable");
    }
    const method = field.value;
    result[key] = (...args: unknown[]) => Reflect.apply(method, value, args);
  }
  return Object.freeze(result) as T;
};
const snapshot = <T>(value: T, path = "", depth = 0): T => {
  if (depth > 16 || types.isProxy(value)) {throw new TypeError("Docker recipe data unavailable");}
  if (value === null || typeof value !== "object") {return value;}
  if (path === "initOptions.signal" || path === "resources.localCut.hostShutdownSignal") {
    custodyDataRecord(value);
    if (Object.getPrototypeOf(value) !== AbortSignal.prototype) {throw new TypeError("Docker recipe signal unavailable");}
    return snapshotDockerEngineCall({signal: value, deadlineEpochMs: 0}).signal as T;
  }
  const keys = Object.hasOwn(portKeys, path) ? portKeys[path] : undefined;
  if (keys !== undefined) {return snapshotPort(value, keys);}
  const data = custodyDataRecord(value);
  if (![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Docker recipe facts unavailable");
  }
  const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(data)) {
    if (Array.isArray(value) && key === "length") {continue;}
    if (typeof key !== "string") {throw new TypeError("Docker recipe facts unavailable");}
    Object.defineProperty(result, key, {enumerable: true,
      value: snapshot(Reflect.get(data, key), path === "" ? key : `${path}.${key}`, depth + 1)});
  }
  return Object.freeze(result) as T;
};

const subjectKeys = ["operationId", "attemptId", "custodyId", "executionGenerationId", "authorityVectorDigest", "hostBootId"] as const;
const recipes = new WeakMap<object, Readonly<{subject: NodeDockerRouteSubject; preparation: Preparation; policy: string; isOpen(): boolean}>>();
const selected = new WeakSet<object>();

// Private adapter provenance, wired once by feature composition. The
// route is an exact, frozen projection of one issued recipe, not a caller port.
const nodeDockerRoutePolicy = (policy: Policy): string =>
  canonicalJsonSha256(snapshotDockerEnginePolicy({...custodyDataRecord(policy), allowedNetworkName: "ar-identity-read-only"}));

const retainNodeDockerRoute = (route: Route, subject: NodeDockerRouteSubject,
  preparation: Preparation, isOpen: () => boolean): void => {
  const captured = snapshot(preparation);
  recipes.set(route, Object.freeze({subject: snapshot(subject), preparation: captured, policy: nodeDockerRoutePolicy(captured.enginePolicy), isOpen}));
};

const selectNodeDockerRoute = <P extends Preparation>(recipe: Readonly<{route: Route; preparation: P}>, binding: Binding, policy: string,
  pins: Pick<Route, "nsenter" | "nft">): Readonly<{engine: Route["engine"]; preparation: P; isOpen(): boolean}> => {
  const data = custodyDataRecord(recipe);
  const preparation = snapshot(data.preparation);
  const route = data.route;
  const routeData = custodyDataRecord(route);
  const nsenter = snapshot(routeData.nsenter);
  const nft = snapshot(routeData.nft);
  const engine = snapshot(routeData.engine);
  const owner = recipes.get(route);
  if (owner === undefined || selected.has(route) || !owner.isOpen() || owner.policy !== policy ||
      preparation.openLifecycle !== owner.preparation.openLifecycle ||
      preparation.engineIdentity !== owner.preparation.engineIdentity ||
      nodeDockerRoutePolicy(preparation.enginePolicy) !== policy ||
      subjectKeys.some(key =>
        !owner.subject[key] || owner.subject[key] !== binding[key]) ||
      (["nsenter", "nft"] as const).some(key =>
        ({nsenter, nft})[key].path !== pins[key].path || ({nsenter, nft})[key].sha256 !== pins[key].sha256)) {
    throw new TypeError("Docker route recipe provenance mismatch");
  }
  selected.add(route);
  return Object.freeze({engine, preparation, isOpen: owner.isOpen});
};

return Object.freeze({nodeDockerRoutePolicy, retainNodeDockerRoute, selectNodeDockerRoute});
};
