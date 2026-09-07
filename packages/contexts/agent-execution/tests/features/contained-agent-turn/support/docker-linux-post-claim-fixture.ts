import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {networkFixture} from "../../../fixtures/docker-operation-network-fixture.ts";
import {MemoryV4Storage} from "../../../fixtures/host-http-egress-v4-fixture.ts";
import {MemoryStorage, engineCall, createInput} from "./docker-host-custody-lifecycle-fixture.ts";
import {committedDispatchProofFixture} from "./committed-dispatch-proof-fixture.ts";
import {initOptions} from "./docker-claim-init-fixture.ts";
import {ids, openInput} from "./current-provider-owner-fixture.ts";
import {DockerHostCustodyLifecycle} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {DockerCustodyJournal} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {decodeInspection} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-codec.js";
import {dockerCustodyOwnerIdentitySha256} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-codec.js";
import {HostHttpEgressV4Journal} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import {v4Hash} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js";
import {DOCKER_CUSTODY_INIT_PROTOCOL, DockerCustodyFrameDecoder, encodeDockerCustodyFrame,
  type DockerCustodyProtocolMessage} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import type {DockerEngineIdentity, DockerEnginePort} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
import type {createDockerLinuxPostClaimPreparation} from "../../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";

type Dependencies = Parameters<typeof createDockerLinuxPostClaimPreparation>[0];
export const ROOT = "/tmp/ar69-r276-synthetic-network";
export const GENERATION = "a".repeat(64);
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});
/** Structural view of the lease the Linux route owner returns. This fixture
 * installs no kernel route, opens no namespace and pins no tool. */
export const syntheticLease = () => Object.freeze({cutoff: Promise.resolve("closed" as const),
  reserveFirstWrite: () => ({consume: () => false}), revoke: () => "closed" as const,
  releaseAfterContainerRemoval: async () => "closed" as const});

type SyntheticEngineContext = Readonly<{
  record: (name: string) => void;
  faults: {identity: boolean; journal: boolean; launch: boolean; listener: boolean};
  state: {running: boolean; removed: boolean; attached: boolean; initReady: boolean};
  network: ReturnType<typeof networkFixture>;
  engineIdentity: DockerEngineIdentity;
}>;

/** Synthetic Docker Engine over the operation network fixture's wire client and
 * an in-memory init channel. No daemon, socket, image or process is involved. */
const syntheticEngine = (context: SyntheticEngineContext): DockerEnginePort => {
  const {record, faults, state, network, engineIdentity} = context;
  const subject = network.subject;
  return {

  async identity() {record("identity"); return engineIdentity;},
  async create(request) {
    record("create");
    assert.equal(request.ownerIdentitySha256, dockerCustodyOwnerIdentitySha256(subject.attempt));
    // NetworkMode can only name a network that the daemon already holds.
    assert.notEqual(network.state.network, undefined, "the operation network must exist before create");
    if (faults.launch) {throw new Error("synthetic create failure");}
    return network.container;
  },
  async attachCustody() {
    record("attach"); state.attached = true;
    const decoder = new DockerCustodyFrameDecoder();
    const queued: Uint8Array[] = []; let waiting: ((value: IteratorResult<Uint8Array>) => void) | undefined;
    let closed = false;
    const push = (message: DockerCustodyProtocolMessage) => {
      const bytes = encodeDockerCustodyFrame(message);
      if (waiting === undefined) {queued.push(bytes); return;}
      const resolve = waiting; waiting = undefined; resolve({done: false, value: bytes});
    };
    return {
      output: {[Symbol.asyncIterator]() {return {
        next() {
          const value = queued.shift();
          if (value !== undefined) {return Promise.resolve({done: false as const, value});}
          if (closed) {return Promise.resolve({done: true as const, value: undefined});}
          return new Promise<IteratorResult<Uint8Array>>(resolve => {waiting = resolve;});
        },
        async return() {return {done: true as const, value: undefined};},
      };}},
      async write(bytes: Uint8Array) {
        for (const message of decoder.push(bytes)) {
          record(message.kind);
          if (message.kind === "host-handshake" && state.initReady) {
            push({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
              nonce: message.nonce, observedIdentity: message.expectedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL});
          }
        }
      },
      async closeInput() {},
      async close() {closed = true; waiting?.({done: true, value: undefined}); waiting = undefined; state.attached = false;},
    };
  },
  async start() {record("start"); state.running = true; network.attach();},
  async inspect(authority) {
    record("inspect");
    if (state.removed) {return {authority, cgroupTree: "unobserved", engine: engineIdentity, existence: "absent"};}
    const raw = network.state.containerRaw;
    return decodeInspection({...raw, State: {...raw.State, Running: state.running,
      Pid: state.running ? 42 : 0, Status: state.running ? "running" : "exited",
      FinishedAt: state.running ? raw.State.FinishedAt : "2026-01-01T00:00:01Z"}},
    authority, engineIdentity, network.input.policy);
  },
  async stop() {record("stop"); state.running = false;},
  async kill() {record("kill"); state.running = false;},
  async remove() {record("remove"); state.removed = true; network.detach();},
  async reconcileCreate() {throw new Error("no recovery in post-claim fixture");},
  logs() {throw new Error("no logs in post-claim fixture");},
  async wait() {throw new Error("no wait in post-claim fixture");},
  };
};

/** Actual Docker Host Custody lifecycle, operation network owner, V4 ledger and
 * Host listener slots over a synthetic Engine and in-memory init channel. There
 * is no real socket, namespace, nftables rule, provider process or credential
 * here: this fixture proves ordering and ownership, never route enforcement. */
export const postClaimFixture = async (t: TestContext, gateway?: string) => {
  const create = createInput(ROOT);
  const seed = {imageDigest: create.imageDigest, attempt: {launchFingerprintSha256: create.launchFingerprintSha256,
    operationNonceSha256: create.operationNonceSha256}};
  const template = networkFixture(seed as never, gateway).subject;
  const opened = openInput(ids("codex", "docker-linux-post-claim"), "codex", {provider: "codex",
    adapterRevision: "adapter:test", binaryRevision: "binary:test", capabilityManifestRevision: "manifest:test"});
  const proof = committedDispatchProofFixture(opened, {hostBootId: template.attempt.hostBootId,
    hostInstanceId: template.attempt.hostInstanceId, hostCustodyProof: {proofId: "proof:synthetic-docker-linux"}} as never,
  {tenantId: template.attempt.tenantId, projectId: template.attempt.projectId, operationId: template.attempt.operationId,
    attemptId: template.attempt.attemptId, custodyId: template.attempt.custodyId, effectId: template.effectId,
    workspaceId: template.workspaceId, executionGenerationId: template.executionGenerationId} as never);
  const network = networkFixture({...template, committedClaimSha256: proof.proofDigest.slice(7),
    acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)}, gateway);
  const subject = network.subject;
  const engineIdentity: DockerEngineIdentity = {...subject.attempt, cgroupDriver: "systemd", cgroupVersion: "2",
    storageDriver: "overlay2", engineVersion: "29.6.1"};

  const events: string[] = [];
  /** Cut-off and fault injection points, keyed by the step they belong to. */
  const hooks: Record<string, (() => void) | undefined> = {};
  const record = (name: string): void => {events.push(name); hooks[name]?.();};
  const state = {running: false, removed: false, attached: false, initReady: true};
  const faults = {identity: false, journal: false, launch: false, listener: false};
  const engine = syntheticEngine({record, faults, state, network, engineIdentity});
  const lifecycle = new DockerHostCustodyLifecycle(engine, new DockerCustodyJournal(new MemoryStorage()),
    {async proveEmpty() {return "empty";}});

  const v4Storage = new MemoryV4Storage();
  let journal: HostHttpEgressV4Journal | undefined;
  const physical = {opens: 0, seals: 0, closes: 0, consumption: 0, recipes: [] as string[]};
  /** Point-in-time facts of a synthetic Node listener recipe, in the exact shape
   * `NodeHostHttpListener.observe()` publishes. No socket is ever bound. */
  const readback = {
    scope: "retained-node-server-and-delivered-sockets", openState: "not-attempted",
    listenerState: "not-attempted", admissionSealed: false, nativeBindPending: false, closeRequested: false,
    serverCloseAcknowledged: false, sockets: {observed: 0, closeEvents: 0, awaitingClose: 0, droppedWithoutSocket: 0},
    consumerPending: false, consumerWorkPending: false, uncertainty: [] as string[],
  };
  const listener = {
    observe() {return {...readback, sockets: {...readback.sockets}, uncertainty: [...readback.uncertainty]};},
    async open() {
      physical.opens += 1;
      if (faults.listener) {throw new Error("synthetic listener failure");}
      readback.openState = "published"; readback.listenerState = "open";
      return {address: {address: physical.recipes.at(-1)!, family: "IPv4", port: 43_129},
        sealAdmission: listener.sealAdmission, close: listener.close, observe: listener.observe};
    },
    sealAdmission() {physical.seals += 1; readback.admissionSealed = true;},
    async close() {
      physical.closes += 1;
      readback.listenerState = "closed"; readback.closeRequested = true; readback.serverCloseAcknowledged = true;
      return {state: "closed"};
    },
  };
  const routeAdmissions: unknown[] = [];
  const route: {lease: unknown; release: "closed" | "quarantined" | "none"} = {lease: undefined, release: "none"};
  const publishedFirstWrites: unknown[] = [];
  const {allowedNetworkName: _bound, ...enginePolicy} = network.input.policy;
  const policies: string[] = [];
  const dependencies: Dependencies = {
    subjectFacts: {scopeSha256: subject.scopeSha256, observerSha256: subject.observerSha256,
      networkHandle: subject.networkHandle, listenerHandle: subject.listenerHandle, routeHandle: subject.routeHandle},
    create,
    enginePolicy,
    engineClient: network.input.client,
    async engineIdentity() {
      record("engine-identity");
      if (faults.identity) {throw new Error("synthetic engine identity failure");}
      return engineIdentity;
    },
    openLifecycle(policy) {policies.push(policy.allowedNetworkName); return lifecycle;},
    async openResourceJournal(input) {
      record("resource-journal");
      if (faults.journal) {throw new Error("synthetic ledger failure");}
      journal = new HostHttpEgressV4Journal(v4Storage, input.subject, input.observer);
      await journal.prepare(`command:${v4Hash("open-post-claim")}`);
      return journal;
    },
    resources: {
      listenerFor: (bindHost: string) => {physical.recipes.push(bindHost); return listener as never;},
      consumption: {async prepare() {physical.consumption += 1;
        return {kind: "ready", journal: {}, quarantine() {}, async retire() {return "retired";}};}},
      accept: async () => {},
      localCut: {expectedClock: {authorityId: "synthetic-clock", epoch: "1"},
        clock: {read: () => ({authorityId: "synthetic-clock", epoch: "1", controlTime: 1}),
          within: async (_deadline: number, action: () => Promise<unknown>) => action()}, operationDeadline: 20_000},
    } as never,
    initOptions: initOptions() as never,
    hostLifecycleGenerationSha256: GENERATION,
    cleanupMilliseconds: 5_000,
    deadlines: {engineIdentityMs: 5_000, allocationMs: 5_000, launchMs: 5_000, membershipMs: 5_000,
      cleanupMs: 5_000, routeMs: 5_000, routeLifetimeMs: 20_000},
    /** A synthetic admission double: it installs nothing and owns no namespace.
     * `route.lease` switches it between refusal and a structural lease. */
    routeAdmission: {
      async admit(input) {
        record("route-admission"); routeAdmissions.push(input);
        if (route.lease === undefined) {return {kind: "unsupported", reason: "owner"};}
        const lease = route.lease as {reserveFirstWrite: (binding: unknown, id: string) => {consume(): boolean}};
        return {kind: "installed", owner: route.lease as never,
          firstWrite: {reserve: (requestId: string) => lease.reserveFirstWrite(undefined, requestId)}};
      },
      async releaseAfterContainerRemoval() {record("route-release"); return route.release;},
    },
    publishRouteFirstWrite(port) {record("route-first-write"); publishedFirstWrites.push(port);},
  };
  const controller = new AbortController();
  const claimed = Object.freeze({committedDispatchProof: proof, signal: controller.signal,
    underlyingCustodyRef: `urn:agent-runtime:docker-host-reservation:${"b".repeat(64)}`});
  t.after(() => {controller.abort();});
  return {network, subject, proof, claimed, controller, dependencies, events, faults, hooks, state, v4Storage,
    physical, policies, routeAdmissions, route, publishedFirstWrites, syntheticLease, readback, lifecycle, engineCall,
    get journal() {return journal;}};
};
