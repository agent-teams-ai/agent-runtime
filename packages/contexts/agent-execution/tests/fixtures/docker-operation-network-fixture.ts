import { DockerOperationNetwork } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-operation-network.js";
import { decodeEngineIdentity } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-codec.js";
import { encodeCreateRequest } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-create-request.js";
import { createSpecificationSha256 } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-create-specification.js";
import { DockerHttpNetworkResources, dockerHttpOperationNetworkRecipe } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-http-network-resources.js";
import type { DockerEngineCall } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import { dockerCustodyOwnerIdentitySha256 } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-codec.js";
import { v4Hash } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import { subject as template } from "./host-http-egress-v4-fixture.ts";
import { policy as basePolicy, createInput, HOST_BOOT, DAEMON_BOOT } from "./docker-engine-test-fixture.ts";

export const call = (signal = new AbortController().signal): DockerEngineCall => ({signal, deadlineEpochMs: Date.now() + 10_000});
export const deferred = <T = void>() => Promise.withResolvers<T>();
const response = (statusCode: number, value?: unknown) => ({statusCode,
  body: value === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(value)), contentType: value === undefined ? "" : "application/json"});
type Client = NonNullable<ConstructorParameters<typeof DockerOperationNetwork>[0]["client"]>;
type WireCall = Parameters<Client["buffered"]>[0];

/** Synthetic external Engine IO only. No Unix socket, native namespace, provider,
 * filesystem preparation or host network is used by this fixture. */
export const networkFixture = (subjectOverride: Partial<typeof template> = {}, gateway = "172.30.0.1") => {
  // The bridge address is whatever the daemon assigned; nothing may assume it.
  const [octetA, octetB] = gateway.split(".");
  const subnet = `${octetA}.${octetB}.0.0/16`; const containerAddress = `${octetA}.${octetB}.0.2`;
  const policy = basePolicy("/tmp/ar69-r276-synthetic-network");
  const info = {ID: "synthetic-network-daemon", ServerVersion: "29.6.1", Driver: "overlay2", CgroupDriver: "systemd", CgroupVersion: "2"};
  const endpoint = {canonicalSocketPath: policy.socketPath, daemonBootGenerationSha256: DAEMON_BOOT, hostBootGenerationSha256: HOST_BOOT};
  const engine = decodeEngineIdentity(info, policy, endpoint);
  const subject = Object.freeze({...template, ...subjectOverride, attempt: Object.freeze({...template.attempt, ...subjectOverride.attempt,
    daemonIdentitySha256: engine.daemonIdentitySha256, daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
    hostIdentitySha256: engine.hostIdentitySha256, hostBootGenerationSha256: engine.hostBootGenerationSha256})});
  const recipe = dockerHttpOperationNetworkRecipe(subject);
  const operationPolicy = {...policy, allowedNetworkName: recipe.name};
  const create = {...createInput("/tmp/ar69-r276-synthetic-network"), imageDigest: subject.imageDigest,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(subject.attempt),
    operationNonceSha256: subject.attempt.operationNonceSha256, launchFingerprintSha256: subject.attempt.launchFingerprintSha256};
  const body = encodeCreateRequest(create, operationPolicy) as any;
  const container = Object.freeze({containerId: v4Hash("actual-operation-container"),
    daemonIdentitySha256: engine.daemonIdentitySha256, daemonBootGenerationSha256: engine.daemonBootGenerationSha256,
    hostIdentitySha256: engine.hostIdentitySha256, hostBootGenerationSha256: engine.hostBootGenerationSha256,
    imageDigest: create.imageDigest, operationNonceSha256: create.operationNonceSha256,
    launchFingerprintSha256: create.launchFingerprintSha256, ownerIdentitySha256: create.ownerIdentitySha256,
    createSpecificationSha256: createSpecificationSha256(create, operationPolicy)});
  const networkId = v4Hash("actual-operation-network"); const endpointId = v4Hash("actual-endpoint");
  const containerRaw: any = {Id: container.containerId, Name: `/ar-turn-${create.operationNonceSha256}`,
    AppArmorProfile: operationPolicy.appArmorProfile,
    Config: Object.fromEntries(["AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "Image", "Labels",
      "NetworkDisabled", "OpenStdin", "StdinOnce", "StopSignal", "Tty", "User", "WorkingDir"].map(key => [key, body[key]])),
    HostConfig: body.HostConfig,
    Mounts: body.HostConfig.Mounts.map((mount: any) => ({Destination: mount.Target, Propagation: "rprivate",
      RW: mount.ReadOnly !== true, Source: mount.Source, Type: "bind"})),
    State: {Dead: false, Error: "", ExitCode: 0, FinishedAt: "0001-01-01T00:00:00Z", OOMKilled: false,
      Paused: false, Pid: 42, Restarting: false, Running: true, StartedAt: "2026-01-01T00:00:00Z", Status: "running"},
    NetworkSettings: {Networks: {[recipe.name]: {NetworkID: networkId, EndpointID: endpointId,
      IPAddress: containerAddress, IPPrefixLen: 16, GlobalIPv6Address: ""}}}};
  const state = {
    network: undefined as any, containerPresent: false, containerRaw,
    createFault: "" as "" | "lost" | "lost-before" | "malformed" | "conflict",
    inspectFault: false, removeFault: "" as "" | "lost" | "lost-before",
    calls: [] as string[], writes: [] as WireCall[],
    after: async (_label: string, _call: DockerEngineCall): Promise<void> => {},
    before: async (_label: string, _call: DockerEngineCall): Promise<void> => {},
  };
  const execute = (input: WireCall) => {
    if (input.path === "/v1.47/info") {return response(200, info);}
    if (input.method !== "GET") {input.beforeWrite?.(); state.writes.push(input);}
    if (input.path === "/v1.47/networks/create") {
      if (state.createFault === "conflict") {return response(409, {message: "exists"});}
      if (state.createFault === "lost-before") {throw new Error("synthetic lost create before effect");}
      const requested = JSON.parse(Buffer.from(input.body!).toString());
      state.network = {...requested, Id: networkId, Scope: "local", Containers: {},
        IPAM: {Driver: "default", Options: null, Config: [{Subnet: subnet, Gateway: gateway}]}};
      if (state.createFault === "lost") {throw new Error("synthetic lost create after effect");}
      return response(201, state.createFault === "malformed" ? {Id: "malformed"} : {Id: networkId, Warning: ""});
    }
    if (input.path.startsWith("/v1.47/networks/")) {
      if (input.method === "DELETE") {
        if (state.removeFault === "lost-before") {throw new Error("synthetic DELETE before effect");}
        state.network = undefined;
        if (state.removeFault === "lost") {throw new Error("synthetic DELETE after effect");}
        return response(204);
      }
      if (state.inspectFault) {throw new Error("synthetic unknown network inspection");}
      return state.network === undefined ? response(404, {message: "absent"}) : response(200, state.network);
    }
    if (input.path === `/v1.47/containers/${container.containerId}/json`) {
      return state.containerPresent ? response(200, containerRaw) : response(404, {message: "absent"});
    }
    throw new Error(`Unexpected synthetic IO ${input.path}`);
  };
  const client: Client = {
    async buffered(input) {
      const label = `${input.method} ${input.path}`; state.calls.push(label);
      await state.before(label, input.call);
      const result = execute(input);
      await state.after(label, input.call);
      return result;
    },
    async endpointIdentity(invocation) {
      state.calls.push("endpoint"); await state.before("endpoint", invocation);
      const result = {...endpoint}; await state.after("endpoint", invocation); return result;
    },
    async stream() {throw new Error("Unexpected synthetic stream");},
  };
  const input = {policy: operationPolicy, client, binding: recipe.binding};
  const current = Object.fromEntries(["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"]
    .map(key => [key, subject.attempt[key as keyof typeof subject.attempt]])) as any;
  Object.assign(current, {effectId: subject.effectId, workspaceId: subject.workspaceId,
    executionGenerationId: subject.executionGenerationId, committedClaimSha256: subject.committedClaimSha256,
    acceptedAuthoritySha256: subject.acceptedAuthoritySha256});
  const attach = () => {
    state.containerPresent = true;
    state.network.Containers = {[container.containerId]: {Name: "descriptive-only", EndpointID: endpointId,
      IPv4Address: `${containerAddress}/16`, IPv6Address: "", MacAddress: "02:42:ac:1e:00:02"}};
  };
  /** The daemon drops a removed container's endpoint from the network it joined. */
  const detach = () => {
    state.containerPresent = false;
    if (state.network !== undefined) {state.network.Containers = {};}
  };
  const resourceInput = {subject, engine: {policy: operationPolicy, client}, cleanupMilliseconds: 5_000};
  return {state, input, subject, current, endpoint, container, networkId, attach, detach, resourceInput, gateway,
    open: () => new DockerOperationNetwork(input), resources: () => new DockerHttpNetworkResources(resourceInput)};
};
