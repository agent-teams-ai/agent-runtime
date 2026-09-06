import { addAbortListener } from "node:events";
import { isIPv4 } from "node:net";
import { canonicalJsonSha256 } from "./docker-canonical-json.js";
import { snapshotOwnDataObject } from "./docker-boundary-snapshot.js";
import type { DockerContainerAuthority, DockerEngineCall, DockerEngineIdentity } from "./docker-engine-port.js";

export const networkFailure = (): Error => new Error("Docker operation network custody is unproven");
export const networkDigest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {throw networkFailure();}
  return value;
};
export const networkObject = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw networkFailure();}
  return value as Record<string, unknown>;
};
const engineKeys = ["daemonIdentitySha256", "daemonBootGenerationSha256", "hostIdentitySha256", "hostBootGenerationSha256"] as const;
const bindingKeys = [...engineKeys, "operationSha256", "executionGenerationSha256", "networkHandleSha256",
  "ownerIdentitySha256", "operationNonceSha256", "launchFingerprintSha256"] as const;
/** Docker-private fixed recipe. No endpoint selection or general network grants. */
export type DockerOperationNetworkBinding = Readonly<Record<typeof bindingKeys[number], string>>;
export const networkBinding = (input: DockerOperationNetworkBinding): DockerOperationNetworkBinding => {
  const value = snapshotOwnDataObject(input, bindingKeys, bindingKeys, "invalid-authority");
  return Object.freeze(Object.fromEntries(bindingKeys.map(key => [key, networkDigest(value[key])]))) as DockerOperationNetworkBinding;
};
export const operationNetworkName = (input: DockerOperationNetworkBinding): string =>
  `ar-http-${canonicalJsonSha256(networkBinding(input))}`;
export const assertNetworkEngine = (binding: DockerOperationNetworkBinding, engine: DockerEngineIdentity): void => {
  if (engineKeys.some(key => binding[key] !== engine[key])) {throw networkFailure();}
};
export const assertNetworkContainer = (binding: DockerOperationNetworkBinding, container: DockerContainerAuthority): void => {
  if ([...engineKeys, "ownerIdentitySha256", "operationNonceSha256", "launchFingerprintSha256"]
    .some(key => binding[key as keyof DockerOperationNetworkBinding] !== container[key as keyof DockerContainerAuthority])) {
    throw networkFailure();
  }
};
export const operationNetworkLabels = (binding: DockerOperationNetworkBinding, allocation: string) => Object.freeze({
  "com.agent-runtime.http-operation-network": "1",
  ...Object.fromEntries(bindingKeys.map(key => [`com.agent-runtime.http.${key}`, binding[key]])),
  "com.agent-runtime.http.allocation": networkDigest(allocation),
});
export type DockerOperationNetworkObservation = Readonly<{
  networkId: string; gateway: string; evidenceSha256: string;
  endpoint: Readonly<{containerId: string; endpointId: string; address: string}> | null;
}>;
/** Strict values for the fixed internal bridge recipe; descriptive Engine fields
 * (Created, IPAM subnet, bridge MAC) are observed but never ownership authority. */
export const decodeOperationNetwork = (input: Readonly<{
  value: unknown; name: string; labels: Readonly<Record<string, string>>; networkId: string | undefined;
  container: DockerContainerAuthority | undefined;
}>): DockerOperationNetworkObservation => {
  const value = networkObject(input.value);
  const id = networkDigest(value.Id);
  if (input.networkId !== undefined && id !== input.networkId || value.Name !== input.name ||
    value.Driver !== "bridge" || value.Scope !== "local" || value.Internal !== true ||
    value.Attachable !== false || value.Ingress !== false || value.EnableIPv6 !== false ||
    value.EnableIPv4 !== undefined && value.EnableIPv4 !== true ||
    canonicalJsonSha256(networkObject(value.Labels)) !== canonicalJsonSha256(input.labels) ||
    canonicalJsonSha256(networkObject(value.Options)) !== canonicalJsonSha256({"com.docker.network.bridge.enable_icc": "false"})) {
    throw networkFailure();
  }
  const ipam = networkObject(value.IPAM);
  const configs = ipam.Config;
  if (ipam.Driver !== "default" || !Array.isArray(configs) || configs.length !== 1 ||
    ipam.Options !== null && canonicalJsonSha256(networkObject(ipam.Options)) !== canonicalJsonSha256({})) {throw networkFailure();}
  const gateway = networkObject(configs[0]).Gateway;
  if (typeof gateway !== "string" || !isIPv4(gateway)) {throw networkFailure();}
  const [a, b] = gateway.split(".").map(Number);
  if (!(a === 10 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168)) {throw networkFailure();}
  const members = Object.entries(networkObject(value.Containers));
  if (members.length > 1 || members.length === 1 && members[0]![0] !== input.container?.containerId) {throw networkFailure();}
  let endpoint: DockerOperationNetworkObservation["endpoint"] = null;
  if (members.length === 1) {
    const [containerId, raw] = members[0]!;
    const member = networkObject(raw);
    const address = member.IPv4Address;
    if (typeof address !== "string" || !/^.+\/(?:[1-9]|[12][0-9]|3[0-2])$/u.test(address) ||
      !isIPv4(address.split("/")[0]!) || member.IPv6Address !== "") {throw networkFailure();}
    endpoint = Object.freeze({containerId, endpointId: networkDigest(member.EndpointID), address});
  }
  return Object.freeze({networkId: id, gateway, endpoint, evidenceSha256: canonicalJsonSha256(value)});
};

/** A cleanup deadline bounds observation of retained work, never its ownership.
 * Late work stays retained by its original slot and must be reobserved later. */
export const awaitNetworkCleanupWork = async (work: Promise<unknown> | undefined, call: DockerEngineCall): Promise<void> => {
  if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {throw networkFailure();}
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: ReturnType<typeof addAbortListener> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      const fail = () => reject(networkFailure());
      abort = addAbortListener(call.signal, fail);
      timer = setTimeout(fail, Math.min(call.deadlineEpochMs - Date.now(), 120_000));
    })]);
    if (call.signal.aborted || Date.now() >= call.deadlineEpochMs) {throw networkFailure();}
  } finally {clearTimeout(timer); abort?.[Symbol.dispose]();}
};
