// Private test administration support. No provider, Engine or network I/O.
import {readFile} from "node:fs/promises";
import {createContainedTurnRouteEnforcement,snapshotDockerEnginePolicy} from
  "@agent-teams/agent-execution/composition";
import {routeSelectionDigest, snapshotRouteSelectionFacts} from
  "@agent-teams/provider-access/composition";
import type {LinuxCodexLivePins} from "./linux-codex-live-bootstrap.ts";

const target = Object.freeze({
  provider: "codex",
  providerAdapter: "codex-app-server-contained-turn:0.153.4+native-permission-config-v2",
  binaryClosure: "@openai/codex:0.153.4+linux-x64",
  platform: "linux-x64",
  credentialRoute: "provider-access-endorsed-codex-chatgpt-host-materialized-credential-binding",
  storageTopology: "digest-pinned-readonly-rootfs-with-disposable-host-bound-workspace-and-private-home",
  transportTopology: "codex-native-http-over-nftables-exclusive-route-to-host-broker-then-host-tls-to-provider-origin",
  failureDomain: "single-linux-host-container-with-host-custodied-broker",
});

/** This is expected deployment configuration, never a PA receipt or current
 * authority reader. The product deployment subsequently reads PA's durable
 * endorsement and RS's acknowledged head, and binds the committed operation
 * through bindContainedTurnRouteEnforcement. No expected value replaces that
 * readback. Empty operation fields keep this initial admission unusable until
 * the existing deployment owner supplies those acknowledged fields.
 */
export const createLinuxCodexLiveAdminRoute = async (input: Readonly<{
  sourceRevision: string;
  route: Pick<LinuxCodexLivePins["route"], "binding" | "recipe" | "descriptor">;
  hostBootId: string;
  capabilityManifestRevision: string;
  enginePolicy: LinuxCodexLivePins["node"]["enginePolicy"];
  tools: LinuxCodexLivePins["node"]["tools"];
}>) => {
  // Detach before the first await, including nested administrative facts.
  // Pick is only a static type: administration supplies the full route owner
  // configuration, including its deadline and native cancellation signal.
  const facts = snapshotRouteSelectionFacts({binding: input.route.binding,
    recipe: input.route.recipe, descriptor: input.route.descriptor});
  const pins = structuredClone({...input, route: facts});
  if (process.platform !== "linux" || process.arch !== "x64" ||
      !/^[a-f0-9]{40}$/u.test(pins.sourceRevision) || !pins.hostBootId || !pins.capabilityManifestRevision || pins.route.recipe !== "codex-chatgpt") {
    throw new TypeError("Linux Codex administrative route configuration unavailable");
  }
  const registry: unknown = JSON.parse(await readFile(new URL(
    "../../../../../docs/architecture/qualification-registry.json", import.meta.url), "utf8"));
  // Read the repository registry; never substitute a fixture or caller registry.
  const rows = (registry as {entries?: unknown[]}).entries;
  if (!Array.isArray(rows) || !rows.some(value => {
    const row = value as {id?: unknown; qualification?: unknown; targets?: unknown[]};
    return row?.id === "docker-linux-codex-enforced-network-route" && row.qualification === "implementation" &&
      Array.isArray(row.targets) && row.targets.some(candidate => {
        if (candidate === null || typeof candidate !== "object") {return false;}
        const targetFacts = candidate as Record<string, unknown>;
        return Object.keys(targetFacts).length === Object.keys(target).length &&
          Object.entries(target).every(([key, expected]) => targetFacts[key] === expected);
      });
  })) {throw new TypeError("Exact Linux Codex registry target unavailable");}
  const binding = pins.route.binding;
  const routeRevision = await routeSelectionDigest(pins.route);
  // As in the production Node recipe, this policy name is never allocated.
  const policy = snapshotDockerEnginePolicy({...pins.enginePolicy, allowedNetworkName: "ar-identity-read-only"});
  const engine = Object.freeze({inspect: async (): Promise<never> => {
    throw new TypeError("Linux Codex route requires its operation recipe");
  }});
  return createContainedTurnRouteEnforcement({qualificationTarget: target, engine, enginePolicy: policy,
    nsenter: pins.tools.nsenter, nft: pins.tools.nft,
    binding: {
      tenantId: binding.tenantId, projectId: binding.projectId, scopeDigest: binding.scopeDigest,
      accessRef: binding.accessRef, providerAccountRef: binding.providerAccountRef,
      providerRouteRef: binding.providerRouteRef, bindingRevision: binding.bindingRevision,
      credentialBindingRef: binding.credentialBindingRef,
      credentialBindingDigest: binding.credentialBindingDigest,
      credentialGeneration: binding.credentialGeneration, routeRevision,
      sourceRevision: pins.sourceRevision, hostBootId: pins.hostBootId,
      adapterRevision: target.providerAdapter, binaryRevision: target.binaryClosure,
      capabilityManifestRevision: pins.capabilityManifestRevision,
      operationId: "", attemptId: "", custodyId: "", executionGenerationId: "", authorityVectorDigest: "",
    },
  });
};
