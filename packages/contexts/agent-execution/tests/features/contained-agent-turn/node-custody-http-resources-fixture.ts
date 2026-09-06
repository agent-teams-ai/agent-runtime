import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import { after } from "node:test";
import { modules, nodeFixture as baseNodeFixture, liveFor, Core, createEgressFixture, access, Kernel } from "./native-launch-finalization-fixture.ts";
export { liveFor, Core, Kernel };
import { committedDispatchProofFixture } from "./support/committed-dispatch-proof-fixture.ts";
export const deferred = <T>() => Promise.withResolvers<T>();
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});

// Install event-only native net and memory storage/lock bindings BEFORE importing
// the concrete listener and consumption adapters. No real socket/lock/file opens.
const servers: MemoryServer[] = [];
let behavior: {listen?: () => void; autoBind: boolean; autoClose: boolean} = {autoBind: true, autoClose: true};
class MemoryServer extends EventEmitter {
  public listening = false;
  public closeCalls = 0;
  public maxConnections = 0;
  public constructor() {super(); servers.push(this);}
  public listen() {behavior.listen?.(); if (behavior.autoBind) {queueMicrotask(() => this.bind());} return this;}
  public bind() {this.listening = true; this.emit("listening");}
  public address() {return {address: "10.203.0.1", family: "IPv4", port: 43129};}
  public close() {this.closeCalls += 1; if (behavior.autoClose) {queueMicrotask(() => this.ackClose());} return this;}
  public ackClose() {this.listening = false; this.emit("close");}
}
modules.set("node:net", {Server: MemoryServer, isIPv4: (value: string) => value === "10.203.0.1"});
let storageGate: Promise<void> | undefined;
let storageOpen: (() => void) | undefined;
const storage = {opens: 0, closes: 0, locks: 0, tombstones: 0, created: 0, retiredUnknown: false,
  closeGate: undefined as Promise<void> | undefined, disposition: "", bytes: Buffer.alloc(0)};
modules.set("retention-lock", {withStableDirectoryProcessLock: async (_directory: object, action: () => Promise<void>) => {
  storage.locks += 1;
  try {await action();} finally {storage.locks -= 1;}
}});
modules.set("./host-http-consumption-storage.js", {
  captureConsumptionDirectory: (input: object) => Object.freeze({...input}),
  HostHttpConsumptionStorage: class {
    public readonly directory = {};
    public remainingBytes = 1_048_576;
    public static async open() {storage.opens += 1; storageOpen?.(); await storageGate; return new this();}
    public hasResidue() {return false;}
    public create(bytes: Buffer) {storage.created += 1; storage.bytes = bytes;}
    public assertIntact() {}
    public append(bytes: Buffer) {storage.bytes = Buffer.concat([storage.bytes, bytes]);}
    public persistTombstone(bytes: Buffer) {storage.tombstones += 1; storage.disposition = bytes.toString(); return true;}
    public async close() {storage.closes += 1; await storage.closeGate; if (storage.retiredUnknown) {throw new Error("synthetic cleanup loss");}}
  },
});
const lockHook = registerHooks({resolve(specifier, context, next) {
  if (specifier === "@agent-teams/filesystem-custody" && context.parentURL?.includes("node-host-http-consumption-journal")) {
    return {url: "native-finalization-fixture:retention-lock", shortCircuit: true};
  }
  return next(specifier, context);
}});
after(() => lockHook.deregister());
const {createNodeHostHttpListener} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-listener.js");
const {createNodeHostHttpConsumptionJournal} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/node-host-http-consumption-journal.js");
export const {createV4HostHttpListenerLifecycle} = await import("../../../dist/features/contained-agent-turn/composition/v4-host-http-listener-lifecycle.js");
const {HostHttpEgressV4Journal} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js");
const {v4Hash, v4Decode} = await import("../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-codec.js");
const {MemoryV4Storage, SyntheticV4Owner, subject: template, container} = await import("../../fixtures/host-http-egress-v4-fixture.ts");

type V4Kind = Parameters<V4JournalType["target"]>[0];
// Type imports are erased by the worker hook and resolve to built dist in CI.
import type { HostHttpEgressV4Journal as V4JournalType } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-journal.js";
import type { HostHttpEgressV4Observed, HostHttpEgressV4Intent } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/host-http-egress-v4-types.js";

export const kernelHost = {hostBootId: template.attempt.hostBootId, hostInstanceId: template.attempt.hostInstanceId};
export const proofFor = (input: Parameters<typeof committedDispatchProofFixture>[0], opened: Parameters<typeof committedDispatchProofFixture>[1]) =>
  committedDispatchProofFixture(input, opened, {executionGenerationId: template.executionGenerationId as never});
export const nodeFixture = async () => {
  const f = await baseNodeFixture();
  const identity = {...f.identity, attemptId: template.attempt.attemptId, operationId: template.attempt.operationId,
    custodyId: template.attempt.custodyId, effectId: template.effectId, workspaceId: template.workspaceId} as typeof f.identity;
  const kernelInput = {...f.kernelInput, ...identity, providerAccessSnapshot: {...f.kernelInput.providerAccessSnapshot,
    tenantId: template.attempt.tenantId, projectId: template.attempt.projectId}};
  const input = {...f.input, attemptId: identity.attemptId, operationId: identity.operationId};
  return {...f, identity, kernelInput, input,
    reserve: () => f.core.reserve(input),
    handoff: (custodyRef: string) => ({underlyingCustodyRef: custodyRef, signal: f.controller.signal,
      committedDispatchProof: proofFor(kernelInput, {...kernelHost, hostCustodyProof: {proofId: "proof:synthetic"}} as never)}),
  };
};

type FixtureOptions = {pendingListen?: boolean; pendingJournal?: Promise<void>; unknownClose?: boolean};
export const fixture = async (options: FixtureOptions = {}) => {
  const f = await nodeFixture();
  const {custodyRef} = await f.reserve();
  return resourcesFor(f, f.preparation.acquire(f.handoff(custodyRef)), options);
};
export const resourcesFor = async (f: Awaited<ReturnType<typeof nodeFixture>>,
  lifetime: ReturnType<typeof f.preparation.acquire>, options: FixtureOptions = {}) => {
  servers.length = 0;
  behavior = {autoBind: !options.pendingListen, autoClose: !options.unknownClose};
  storageGate = options.pendingJournal; storageOpen = undefined;
  Object.assign(storage, {opens: 0, closes: 0, locks: 0, tombstones: 0, created: 0, retiredUnknown: false,
    closeGate: undefined, disposition: "", bytes: Buffer.alloc(0)});
  const custodyRef = lifetime.underlyingCustodyRef;
  const handoff = f.handoff(custodyRef);
  const proof = lifetime.committedDispatchProof;
  const subject = {...template, attempt: {...template.attempt, tenantId: proof.tenantId, projectId: proof.projectId,
    operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
    hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId},
    effectId: proof.effectId, workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
    committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)};
  const v4Storage = new MemoryV4Storage(); const observer = new SyntheticV4Owner();
  const v4 = new HostHttpEgressV4Journal(v4Storage, subject, observer);
  let sequence = 0;
  const command = () => `command:${v4Hash(++sequence)}`;
  const intent = (kind: HostHttpEgressV4Intent) => v4.recordIntent(command(), {kind, targetSha256: v4.target(kind)});
  let hasContainer = false;
  const observe = async (kind: HostHttpEgressV4Observed) => {
    const result = await v4.recordObservation(command(), observer.token({kind,
    subjectSha256: v4Hash(subject), observerSha256: subject.observerSha256, targetSha256: v4.target(kind),
    actualSha256: v4Hash([kind, sequence]), evidenceSha256: v4Hash(["observed", sequence]),
    container: kind === "container_attached" || kind === "container_absent" && hasContainer ? container : null,
    writeOutcome: kind === "sockets_closed" ? "settled" : null}));
    if (kind === "container_attached") {hasContainer = true;}
    return result;
  };
  await v4.prepare(command()); await intent("network_intent"); await observe("network_allocated");
  const waiting = new Set<{deadline: number; fail: () => void}>();
  let time = 0;
  const clock = {
    now: () => time,
    within<T>(deadline: number, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => {waiting.delete(watch); signal?.removeEventListener("abort", fail);};
        const fail = () => {cleanup(); reject(new Error("synthetic deadline/cutoff"));};
        const watch = {deadline, fail};
        if (signal?.aborted || time >= deadline) {fail(); return;}
        waiting.add(watch); signal?.addEventListener("abort", fail, {once: true});
        void action().then(value => {cleanup(); resolve(value); return value;}, fail);
      });
    },
  };
  const listener = createNodeHostHttpListener({host: "10.203.0.1", deadline: 20_000, closureDeadline: 25_000}, clock);
  const consumption = createNodeHostHttpConsumptionJournal({directory: {path: "/synthetic/consumption", device: "1", inode: "1"},
    envelope: {tenantId: proof.tenantId, projectId: proof.projectId, operationId: proof.operationId,
      scopeDigest: `sha256:${subject.scopeSha256}`, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId, executionGenerationId: proof.executionGenerationId,
      selectedDockerAuthorityDigest: `sha256:${v4Hash("synthetic-docker-authority")}`, networkNamespaceIdentity: "synthetic:network",
      cgroupIdentity: "synthetic:cgroup", listenerIdentity: "synthetic:listener", signerIdentity: "synthetic:signer"}});
  const shutdown = new AbortController();
  const localCut = {expectedClock: {authorityId: "synthetic-clock", epoch: "1"},
    clock: {read: () => ({authorityId: "synthetic-clock", epoch: "1", controlTime: time}), within: clock.within},
    operationDeadline: 20_000, hostShutdownSignal: shutdown.signal};
  const resourceInput = {listener, consumption, localCut, listenerLifecycle: createV4HostHttpListenerLifecycle({v4, subject}), accept: async () => {throw new Error("no exchanges in fixture");}};
  const containmentInput = {attemptId: proof.attemptId, operationId: proof.operationId, custodyRef};
  const contain = () => f.core.requestContainment(containmentInput);
  const release = async () => {
    const contained = await contain(); assert.equal(contained.kind, "contained");
    if (contained.kind !== "contained") {throw new Error("synthetic no-start proof missing");}
    return f.core.release({...containmentInput, receiptRef: contained.receiptRef});
  };
  return {...f, custodyRef, handoff, lifetime, resourceInput, v4, subject, v4Storage, observe, intent, containmentInput,
    storage, servers, shutdown, contain, release,
    records: () => v4Decode(v4Storage.journal!).map(record => record.event.kind as V4Kind),
    duringListen: (action: () => void) => {behavior.listen = action;},
    duringStorageOpen: (action: () => void) => {storageOpen = action;},
    advance: (value: number) => {time = value; for (const watch of waiting) {if (time >= watch.deadline) {watch.fail();}}},
    prepare: () => f.preparation.prepareResources(lifetime, resourceInput),
    async authorizeRelease() {await intent("cutoff"); await observe("cutoff_observed"); await observe("container_absent");},
    async finalize() {
      const finalizer = f.preparation.finalize(lifetime);
      const files = await f.install();
      const stage = await finalizer.stage({recipe: f.recipe, files});
      const egress = createEgressFixture();
      const session = finalizer.bindSession({...egress.ports, identity: {operationId: proof.operationId,
        attemptId: proof.attemptId, custodyId: proof.custodyId, hostBootId: proof.hostBootId,
        liveProcessSessionIdentity: lifetime.executionSessionIdentity}, providerAccessSnapshot: {...egress.ports.providerAccessSnapshot, ...access("codex")}});
      return {finalizer, stage, session, bundle: finalizer.commit(stage), egress};
    },
  };
};
