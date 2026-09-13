import { DockerConsumptionObservations, DockerHostCustodyLifecycle, DockerCustodyJournal, decodeInspection, dockerCustodyOwnerIdentitySha256, HostHttpEgressV4Journal, v4Hash, DOCKER_CUSTODY_INIT_PROTOCOL, DockerCustodyFrameDecoder, encodeDockerCustodyFrame, type DockerCustodyProtocolMessage, type DockerEngineIdentity, type DockerEnginePort, type createDockerLinuxPostClaimPreparation } from "@agent-teams/agent-execution/composition";
import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {networkFixture} from "../../../../../../package/support/external/agent-execution/fixtures/docker-operation-network-fixture.ts";
import {MemoryV4Storage} from "../../../../../../package/support/external/agent-execution/fixtures/host-http-egress-v4-fixture.ts";
import {MemoryStorage, engineCall, createInput} from "./docker-host-custody-lifecycle-fixture.ts";
import {committedDispatchProofFixture} from "./committed-dispatch-proof-fixture.ts";
import {initOptions} from "./docker-claim-init-fixture.ts";
import {ids, openInput} from "./current-provider-owner-fixture.ts";
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
  state: {started: boolean; running: boolean; removed: boolean; attached: boolean; initReady: boolean};
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
  async start() {record("start"); state.started = true; state.running = true; network.attach();},
  async inspect(authority) {
    record("inspect");
    if (state.removed) {return {authority, cgroupTree: "unobserved", engine: engineIdentity, existence: "absent"};}
    const raw = network.state.containerRaw;
    return decodeInspection({...raw, State: {...raw.State, Running: state.running,
      Pid: state.running ? 42 : 0, Status: state.running ? "running" : state.started ? "exited" : "created",
      StartedAt: state.started ? raw.State.StartedAt : "0001-01-01T00:00:00Z",
      FinishedAt: !state.started || state.running ? "0001-01-01T00:00:00Z" : "2026-01-01T00:00:01Z"}},
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

/** Point-in-time facts of a synthetic Node listener recipe, in the exact shape
 * `NodeHostHttpListener.observe()` publishes. No socket is ever bound. */
const createListenerReadback = () => ({
  scope: "retained-node-server-and-delivered-sockets", openState: "not-attempted",
  listenerState: "not-attempted", admissionSealed: false, nativeBindPending: false, closeRequested: false,
  serverCloseAcknowledged: false, sockets: {observed: 0, closeEvents: 0, awaitingClose: 0, droppedWithoutSocket: 0},
  consumerPending: false, consumerWorkPending: false, uncertainty: [] as string[],
});

const createListener = (physical: {opens: number; seals: number; closes: number; recipes: string[]},
  faults: {listener: boolean}, record: (name: string) => void) => {
  const readback = createListenerReadback();
  const listener = {
    observe() {return {...readback, sockets: {...readback.sockets}, uncertainty: [...readback.uncertainty]};},
    async open() {
      physical.opens += 1; record("listener-open");
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
  return {listener, readback};
};

/** Actual Docker Host Custody lifecycle, operation network owner, V4 ledger and
 * Host listener slots over a synthetic Engine and in-memory init channel. There
 * is no real socket, namespace, nftables rule, provider process or credential
 * here: this fixture proves ordering and ownership, never route enforcement. */
export const postClaimFixture = async (t: TestContext, gateway?: string, selected?: Readonly<{
  root: string; proof: ReturnType<typeof committedDispatchProofFixture>;
}>) => {
  const root = selected?.root ?? ROOT;
  const create = createInput(root);
  const {policy, DAEMON_BOOT} = await import("../../../../../../package/support/external/agent-execution/fixtures/docker-engine-test-fixture.ts");
  const {BOOT, FixtureResidueIo, statText, privilegeText} = await import("./linux-docker-residue-fixture.ts");
  const {createHash} = await import("node:crypto");
  const networkSelection = selected === undefined ? {} : {policy: {...policy(root), cgroupParent: "agent-runtime.slice"}, create: {...create, ownerIdentitySha256: "f".repeat(64)},
    endpoint: {canonicalSocketPath: policy(root).socketPath, daemonBootGenerationSha256: DAEMON_BOOT,
      hostBootGenerationSha256: createHash("sha256").update(BOOT).digest("hex")}};
  const seed = {imageDigest: create.imageDigest, attempt: {launchFingerprintSha256: create.launchFingerprintSha256,
    operationNonceSha256: create.operationNonceSha256}};
  const template = networkFixture(seed as never, gateway, networkSelection).subject;
  const opened = openInput(ids("codex", "docker-linux-post-claim"), "codex", {provider: "codex",
    adapterRevision: "adapter:test", binaryRevision: "binary:test", capabilityManifestRevision: "manifest:test"});
  const proof = selected?.proof ?? committedDispatchProofFixture(opened, {hostBootId: template.attempt.hostBootId,
    hostInstanceId: template.attempt.hostInstanceId, hostCustodyProof: {proofId: "proof:synthetic-docker-linux"}} as never,
  {tenantId: template.attempt.tenantId, projectId: template.attempt.projectId, operationId: template.attempt.operationId,
    attemptId: template.attempt.attemptId, custodyId: template.attempt.custodyId, effectId: template.effectId,
    workspaceId: template.workspaceId, executionGenerationId: template.executionGenerationId} as never);
  const network = networkFixture({...template, ...(selected === undefined ? {} : {
    attempt: {...template.attempt, tenantId: proof.tenantId, projectId: proof.projectId,
      operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId},
    effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId}), committedClaimSha256: proof.proofDigest.slice(7),
    acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)}, gateway, networkSelection);
  const subject = network.subject;
  const engineIdentity: DockerEngineIdentity = {...subject.attempt, cgroupDriver: "systemd", cgroupVersion: "2",
    storageDriver: "overlay2", engineVersion: "29.6.1"};

  const events: string[] = [];
  /** Cut-off and fault injection points, keyed by the step they belong to. */
  const hooks: Record<string, (() => void) | undefined> = {};
  const record = (name: string): void => {events.push(name); hooks[name]?.();};
  // Only this projection is doubled. Dedicated owner tests validate FD provenance;
  // this fixture asserts the join order without claiming to own Linux objects.
  t.mock.method(DockerConsumptionObservations, "read", async (owner, launch, lease, endpoint, call) => {
    record("consumption-observations");
    assert.equal(owner, lifecycle); assert.equal(lease, route.lease);
    assert.equal(owner.observeLaunch(launch).authority.containerId, network.container.containerId);
    assert.deepEqual(endpoint, {address: network.gateway, port: 43129});
    assert.equal(call.signal.aborted, false);
    return {selectedDockerAuthorityDigest: `sha256:${launch.journal.authoritySha256}`,
      networkNamespaceIdentity: "netns:1:2", cgroupIdentity: "cgroup:3:4"};
  });
  const state = {started: false, running: false, removed: false, attached: false, initReady: true};
  const faults = {identity: false, journal: false, launch: false, listener: false};
  const engine = syntheticEngine({record, faults, state, network, engineIdentity});
  const custodyStorage = new MemoryStorage();
  const custodyJournal = new DockerCustodyJournal(custodyStorage);
  let lifecycle = new DockerHostCustodyLifecycle(engine, custodyJournal, {async proveEmpty() {return "empty";}});
  if (selected !== undefined) {
    const {composeLinuxDockerResidueCustody} = await import("@agent-teams/agent-execution/composition");
    const {residueParent, residueLeaf} = await import("@agent-teams/agent-execution/composition");
    const {PROC_SUPER_MAGIC} = await import("@agent-teams/agent-execution/composition");
    const parent = `/sys/fs/cgroup${residueParent(network.input.policy.cgroupParent, "systemd")}`;
    const io = new FixtureResidueIo(parent);
    const leaf = `${parent}/${residueLeaf(network.container.containerId, "systemd")}`;
    hooks.start = () => {
      io.group(leaf);
      io.node(`${leaf}/cgroup.procs`).contents = "42\n";
      io.node(`${leaf}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
      io.node(`${parent}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
      io.directory("/proc/42", PROC_SUPER_MAGIC, 65532);
      io.file("/proc/42/stat", statText(42), 65532);
      io.file("/proc/42/cgroup", `0::${leaf.slice("/sys/fs/cgroup".length)}\n`, 65532);
      io.file("/proc/42/status", privilegeText(), 65532);
    };
    hooks.stop = () => {
      io.node(`${leaf}/cgroup.procs`).contents = "";
      io.node(`${leaf}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
      io.node(`${parent}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
    };
    hooks.remove = () => {io.removeTree(leaf);};
    const composed = composeLinuxDockerResidueCustody({policy: network.input.policy, journalStorage: custodyStorage}, engine, io);
    lifecycle = composed.lifecycle;
    t.after(async () => {await composed.disposeResidue(engineCall()); assert.equal(io.handles.size, 0);});
  }

  const v4Storage = new MemoryV4Storage();
  let journal: HostHttpEgressV4Journal | undefined;
  const physical = {opens: 0, seals: 0, closes: 0, consumption: 0, recipes: [] as string[]};
  const {listener, readback} = createListener(physical, faults, record);
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
    openLifecycle(selectedPolicy) {policies.push(selectedPolicy.allowedNetworkName); return lifecycle;},
    async openResourceJournal(input) {
      record("resource-journal");
      if (faults.journal) {throw new Error("synthetic ledger failure");}
      journal = new HostHttpEgressV4Journal(v4Storage, input.subject, input.observer);
      await journal.prepare(`command:${v4Hash("open-post-claim")}`);
      return journal;
    },
    resources: {
      listenerFor: (bindHost: string) => {physical.recipes.push(bindHost); return listener as never;},
      consumption: {async prepare() {physical.consumption += 1; record("consumption-prepare");
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
  return {engine, network, subject, proof, claimed, controller, dependencies, events, faults, hooks, state, v4Storage,
    custodyStorage, custodyJournal,
    listener, physical, policies, routeAdmissions, route, publishedFirstWrites, syntheticLease, readback, lifecycle, engineCall,
    get journal() {return journal;}};
};
