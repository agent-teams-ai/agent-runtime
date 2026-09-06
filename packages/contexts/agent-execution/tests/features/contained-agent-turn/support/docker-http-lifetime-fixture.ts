import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {networkFixture} from "../../../fixtures/docker-operation-network-fixture.ts";
import {MemoryStorage, engineCall, createInput} from "./docker-host-custody-lifecycle-fixture.ts";
import {committedDispatchProofFixture} from "./committed-dispatch-proof-fixture.ts";
import {ids, openInput} from "./current-provider-owner-fixture.ts";
import {DockerHostCustodyLifecycle} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import {DockerCustodyJournal} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal.js";
import {DockerCustodyHttpReservation} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-custody-http-reservation.js";
import {decodeInspection} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-codec.js";
import {dockerCustodyOwnerIdentitySha256} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/docker-custody-journal-codec.js";
import type {DockerEngineIdentity, DockerEnginePort} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-engine-port.js";
export {DockerCustodyHttpReservation, DockerHostCustodyLifecycle};
export {deferred} from "../../../fixtures/docker-operation-network-fixture.ts";
export const generation = "a".repeat(64);
export const tick = (): Promise<void> => new Promise(resolve => {setImmediate(resolve);});

/** Actual lifecycle/journal/launch issuer over a synthetic Engine and memory
 * attach channel. No provider session, filesystem, socket or physical proof.
 * The explicit trusted caller below supplies a synthetic committed handoff;
 * it is not evidence of a database COMMIT or full Host composition. */
export const fixture = async (t: TestContext) => {
  const template = networkFixture().subject;
  const input = openInput(ids("codex", "docker-http"), "codex", {provider: "codex", adapterRevision: "adapter:test",
    binaryRevision: "binary:test", capabilityManifestRevision: "manifest:test"});
  // Pass only proof fields; the launch/Engine binding remains a distinct record.
  const proof = committedDispatchProofFixture(input, {hostBootId: template.attempt.hostBootId,
    hostInstanceId: template.attempt.hostInstanceId, hostCustodyProof: {proofId: "proof:synthetic-docker-http"}} as never,
    {tenantId: template.attempt.tenantId, projectId: template.attempt.projectId, operationId: template.attempt.operationId,
      attemptId: template.attempt.attemptId, custodyId: template.attempt.custodyId, effectId: template.effectId,
      workspaceId: template.workspaceId, executionGenerationId: template.executionGenerationId} as never);
  const network = networkFixture({...template, committedClaimSha256: proof.proofDigest.slice(7),
    acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)});
  const subject = network.subject;
  const engineIdentity: DockerEngineIdentity = {...subject.attempt, cgroupDriver: "systemd", cgroupVersion: "2",
    storageDriver: "overlay2", engineVersion: "29.6.1"};
  const calls: string[] = [];
  const state = {running: false, removed: false, attached: false, writes: 0};
  const engine: DockerEnginePort = {
    async identity() {calls.push("identity"); return engineIdentity;},
    async create(create) {
      calls.push("create"); assert.equal(create.ownerIdentitySha256, dockerCustodyOwnerIdentitySha256(subject.attempt));
      assert.equal(create.operationNonceSha256, subject.attempt.operationNonceSha256);
      assert.equal(create.launchFingerprintSha256, subject.attempt.launchFingerprintSha256);
      return network.container;
    },
    async attachCustody() {
      calls.push("attach"); state.attached = true;
      return {output: {async *[Symbol.asyncIterator]() {throw new Error("no init reader in HTTP fixture");}},
        async write() {state.writes += 1; throw new Error("no provider/init writes in HTTP fixture");},
        async closeInput() {}, async close() {state.attached = false;}};
    },
    async start() {calls.push("start"); state.running = true;},
    async inspect(authority) {
      calls.push("inspect");
      if (state.removed) {return {authority, cgroupTree: "unobserved", engine: engineIdentity, existence: "absent"};}
      const raw = network.state.containerRaw;
      return decodeInspection({...raw, State: {...raw.State, Running: state.running,
        Pid: state.running ? 42 : 0, Status: state.running ? "running" : "exited",
        FinishedAt: state.running ? raw.State.FinishedAt : "2026-01-01T00:00:01Z"}},
      authority, engineIdentity, network.input.policy);
    },
    async stop() {calls.push("stop"); state.running = false;},
    async kill() {calls.push("kill"); state.running = false;},
    async remove() {calls.push("remove"); state.removed = true;},
    async reconcileCreate() {throw new Error("no recovery in HTTP fixture");},
    async *logs() {throw new Error("no logs in HTTP fixture");},
    async wait() {throw new Error("no wait in HTTP fixture");},
  };
  const storage = new MemoryStorage();
  const lifecycle = new DockerHostCustodyLifecycle(engine, new DockerCustodyJournal(storage), {async proveEmpty() {return "empty";}});
  const launchCall = engineCall();
  const {tenantId, projectId, operationId, attemptId, custodyId, hostInstanceId, hostBootId} = subject.attempt;
  const launched = await lifecycle.launch({owner: {tenantId, projectId, operationId, attemptId, custodyId, hostInstanceId, hostBootId}, call: launchCall,
    create: {...createInput("/synthetic/docker-http-no-files"), imageDigest: subject.imageDigest,
      launchFingerprintSha256: subject.attempt.launchFingerprintSha256, operationNonceSha256: subject.attempt.operationNonceSha256}});
  const signal = new AbortController();
  const handoff = {committedDispatchProof: proof, underlyingCustodyRef: launched.key.custodyId, signal: signal.signal};
  const reservationInput = {lifecycle, launch: launched, hostLifecycleGenerationSha256: generation, claimed: handoff};
  const createOwner = () => new DockerCustodyHttpReservation(reservationInput);
  const contain = () => lifecycle.contain({...launched, call: engineCall()});
  t.after(async () => {signal.abort(); await contain(); assert.equal(state.writes, 0);});
  return {network, proof, handoff, signal, lifecycle, launched, launchCall, reservationInput, createOwner, contain, calls, state};
};
