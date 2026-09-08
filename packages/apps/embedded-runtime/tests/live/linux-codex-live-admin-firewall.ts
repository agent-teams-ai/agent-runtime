// TEST ONLY: host deployment prerequisite for the authorized disposable LinuxCodexE2E.
// This grants no route qualification, runtime authority or product API.
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {isIPv4, type AddressInfo} from "node:net";
import {
  assertNetworkEngine, assertNetworkContainer, decodeOperationNetwork, networkBinding,
  networkDigest, networkObject, operationNetworkLabels, operationNetworkName,
  type DockerOperationNetworkBinding,
} from "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-operation-network-codec.js";
import type {DockerEngineIdentity, DockerContainerAuthority} from
  "../../../../contexts/agent-execution/dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";

export type FirewallCommand = (tool: "iptables" | "ip" | "docker", argv: readonly string[]) => Promise<string>;
/** Installed absolute executable paths only. No shell, installation, inherited Docker
 * context, or unbounded command output. Rejection can mean a write took effect. */
export function createFirewallCommand(paths: Readonly<Record<"iptables" | "ip" | "docker", string>>): FirewallCommand {
  const pinned = {...paths};
  for (const path of Object.values(pinned)) {
    if (!/^\/[\w/.-]+$/u.test(path)) {throw new TypeError("Absolute installed tool path required");}
  }
  return (tool, argv) => new Promise((resolve, reject) => {
    execFile(pinned[tool], [...argv], {shell: false, timeout: 5000, killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024, encoding: "utf8", env: {PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C"}},
    (error, stdout) => {if (error) {reject(error);} else {resolve(stdout);}});
  });
}

/** Supply these from the committed operation and independently observed Host owner,
 * never by copying labels from the network being inspected. The caller retains
 * the Host/daemon lifetime and local socket custody through cleanup. networkId
 * MUST come from the retained real operation owner's allocate()/inspectMembership() result,
 * never this helper's CLI inspection or a fabricated observer. networkName is
 * operationNetworkName(binding), pinned before allocation. This is explicit
 * owner-authorized TEST-ONLY host administration, not allocation custody proof.
 * The production owner continues verifying its original private allocation. */
export type ExpectedOwnedNetwork = Readonly<{
  binding: DockerOperationNetworkBinding;
  hostEngine: DockerEngineIdentity;
  daemonId: string;
  socketPath: string;
  networkName: string;
  networkId: string;
  container?: DockerContainerAuthority;
}>;
const fail = () => new Error("Test host firewall ownership or endpoint unproven");
const ipv4Number = (value: string) => value.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
function subnetFor(value: unknown, gateway: string): {subnet: string; prefix: number} {
  if (typeof value !== "string") {throw fail();}
  const [address, bits] = value.split("/");
  const prefix = Number(bits);
  if (!address || !isIPv4(address) || !/^(?:[1-9]|[12][0-9]|30)$/u.test(bits ?? "")) {throw fail();}
  const block = 2 ** (32 - prefix), start = ipv4Number(address), host = ipv4Number(gateway);
  if (start % block !== 0 || host <= start || host >= start + block - 1) {throw fail();}
  return {subnet: value, prefix};
}

async function assertBridge(command: FirewallCommand, bridge: string, gateway: string, prefix: number): Promise<void> {
  const links = JSON.parse(await command("ip", ["-j", "-d", "address", "show", "dev", bridge]));
  if (!Array.isArray(links) || links.length !== 1 || links[0].ifname !== bridge ||
      links[0].linkinfo?.info_kind !== "bridge" ||
      !Array.isArray(links[0].addr_info) || !links[0].addr_info.some((a: Record<string, unknown>) =>
        a.family === "inet" && a.local === gateway && a.prefixlen === prefix)) {throw fail();}
}

async function inspectOwnedTuple(command: FirewallCommand, endpoint: AddressInfo, expected: ExpectedOwnedNetwork) {
  const binding = networkBinding(expected.binding);
  assertNetworkEngine(binding, expected.hostEngine);
  if (expected.container) {assertNetworkContainer(binding, expected.container);}
  const id = networkDigest(expected.networkId);
  if (expected.networkName !== operationNetworkName(binding)) {throw fail();}
  if (!/^\/[\w/.-]+$/u.test(expected.socketPath) || !expected.daemonId ||
      endpoint.family !== "IPv4" || !isIPv4(endpoint.address) ||
      !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {throw fail();}
  const docker = (...args: string[]) => command("docker", ["--host", `unix://${expected.socketPath}`, ...args]);
  const info = JSON.parse(await docker("info", "--format", "{{json .}}"));
  if (info.ID !== expected.daemonId) {throw fail();}
  const networks = JSON.parse(await docker("network", "inspect", id));
  if (!Array.isArray(networks) || networks.length !== 1) {throw fail();}
  const raw = networks[0];
  // Observed metadata only: no independent allocation custody is asserted here.
  const allocation = networkDigest(networkObject(networkObject(raw).Labels)["com.agent-runtime.http.allocation"]);
  const observed = decodeOperationNetwork({value: raw, name: expected.networkName,
    labels: operationNetworkLabels(binding, allocation), networkId: id, container: expected.container});
  if (observed.gateway !== endpoint.address) {throw fail();}
  const {subnet, prefix} = subnetFor(raw.IPAM.Config[0].Subnet, observed.gateway);
  const bridge = `br-${id.slice(0, 12)}`; // Fixed codec recipe forbids a custom bridge name.
  await assertBridge(command, bridge, observed.gateway, prefix);
  return {bridge, subnet, gateway: observed.gateway};
}

/** Retain this owner BEFORE allow(). A failed/aborted allow can still own a rule.
 * Calls serialize; cleanup queued during allow prevents further use. Pending means
 * retry cleanup on the same owner; do not dispose its Host/network resources yet.
 *
 * Integration in the authorized disposable harness retaining DockerOperationNetwork:
 *   const binding = committedNetworkInput.binding; // retained construction input
 *   const observation = await network.allocate(call); // real retained owner
 *   const expectedOwnedNetwork = {binding, hostEngine, daemonId, socketPath,
 *     networkName: operationNetworkName(binding), networkId: observation.networkId};
 * hostEngine and daemonId come from the retained Host's identity observation;
 * socketPath is its pinned local daemon socket. Do not infer any of these from
 * network labels. If already attached, use network.inspectMembership(call) and include the
 * retained container authority. Keep that real network owner through cleanup.
 * At result.preparation.resources.listenerFor(observation.gateway):
 *   const opened = await originalListener.open(...args); // actual bound address
 *   try { await firewall.allow(opened.address, expectedOwnedNetwork, signal); }
 *   catch (error) { await firewall.cleanup(); throw error; }
 *   return opened;
 * Retain both listener and firewall in the outer cleanup owner even if open fails.
 * On cancel/close stop listener, then await firewall.cleanup(); if either cleanup
 * is uncertain retain both owners and retry. Never replace the returned address
 * with the requested gateway/port or fabricate a successful listener result.
 */
export function createLinuxCodexLiveAdminFirewall(command: FirewallCommand) {
  const comment = `ar-test-host-${randomUUID()}`;
  let rule: string[] | undefined;
  let used = false, closing = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work); tail = next.catch(() => {}); return next;
  };
  const list = () => command("iptables", ["-w", "2", "-t", "filter", "-S", "INPUT"]);
  const ownLines = (listing: string) => listing.split("\n").filter(line => line.includes(comment));
  const rollback = async (): Promise<"removed" | "pending"> => {
    if (!rule) {return "removed";}
    try {
      if (ownLines(await list()).length) {
        // Exact match only, never line-number deletion or chain/policy manipulation.
        try {await command("iptables", ["-w", "2", "-t", "filter", "-D", "INPUT", ...rule]);} catch { /* Read back ambiguous delete. */ }
      }
      if (ownLines(await list()).length) {return "pending";}
      rule = undefined;
      return "removed";
    } catch {return "pending";}
  };
  return Object.freeze({
    allow(actualEndpoint: AddressInfo, expectedOwnedNetwork: ExpectedOwnedNetwork, signal?: AbortSignal): Promise<void> {
      const endpoint = {...actualEndpoint}, expected = structuredClone(expectedOwnedNetwork);
      return serial(async () => {
        if (used || closing || signal?.aborted) {throw fail();}
        used = true;
        try {
          const {bridge, subnet, gateway} = await inspectOwnedTuple(command, endpoint, expected);
          if (ownLines(await list()).length || signal?.aborted || closing) {throw fail();}
          rule = ["-i", bridge, "-s", subnet, "-d", `${gateway}/32`, "-p", "tcp",
            "-m", "tcp", "--dport", String(endpoint.port), "-m", "comment", "--comment", comment, "-j", "ACCEPT"];
          await command("iptables", ["-w", "2", "-t", "filter", "-I", "INPUT", "1", ...rule]);
          await command("iptables", ["-w", "2", "-t", "filter", "-C", "INPUT", ...rule]);
          if (signal?.aborted || closing) {throw fail();}
        } catch (error) {await rollback(); throw error;}
      });
    },
    cleanup(): Promise<"removed" | "pending"> {closing = true; return serial(rollback);},
  });
}
