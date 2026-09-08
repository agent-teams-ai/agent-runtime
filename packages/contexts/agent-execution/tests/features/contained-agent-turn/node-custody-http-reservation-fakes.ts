import assert from "node:assert/strict";
import * as launch from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import * as evidence from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-evidence.js";
import { FakeHost } from "./support/current-provider-owner-fixture.ts";
import type { LiveCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-state.js";

export const deferred = <Value>() => Promise.withResolvers<Value>();
export const tick = () => new Promise<void>(resolve => {setImmediate(resolve);});
let live!: LiveCustody;
let callbacks: any;
let acknowledgement: any;
let candidateFailure = false;
let launchFailure = false;
let openingGate: Promise<void> | undefined;
let containmentGate: ReturnType<typeof deferred<any>> | undefined;
let containmentCalls = 0;
let closedPins = 0;
let closedPrivateRoots = 0;
let launchCalls = 0;
let duringLaunch: (() => void) | undefined;
let duringAcknowledgement: (() => void) | undefined;
let duringPinClose: (() => void) | undefined;
let processExit: Promise<{code: number | null; signal: null}>;
const launched = new FakeHost();
const plan = Object.freeze({arguments: Object.freeze(["synthetic"]), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
  environment: Object.freeze({LANG: "C.UTF-8"}), executablePath: "/synthetic/never-executed", executableSha256: "3".repeat(64),
  intentMode: "analysis", privateRootPath: "/synthetic/private", provider: "codex", spawnMode: "sdk-delegated"});
const workspace = Object.freeze({dev: 1n, ino: 2n, ctimeNs: 1n, mode: 0o40700n, uid: 1n});
const capture = (value: LiveCustody) => {live = value;};
// Only I/O/OS seams are synthetic. Core maps, createLiveCustody, open, replay,
// delegated fingerprint/start, no-start containment and release remain real.
const privateReservation = {
    assertRetainedWorkspaceAuthority: capture, assertReservedWorkspaceAuthority: capture,
    closeRetainedWorkspaceAuthority: (value: LiveCustody) => value.retainedWorkspaceAuthority?.close(),
    bindPrivateHostCustodyReservation: async (input: any) => {
      let closed = false;
      return {plan: input.launchPlan, launchPlans: {resolve: async () => input.launchPlan}, retainedWorkspaceAuthority: {
        descriptor: 99, descriptorPath: "/synthetic/pin", identity: workspace, assertLaunchDescriptor() {},
        close() {if (!closed) {duringPinClose?.(); closed = true; closedPins += 1;}},
      }};
    },
  };
const launchObservation = {...launch, verifyExecutable: async () => ({...workspace, digest: plan.executableSha256}),
    resolveLaunchCandidate: async (_resolver: unknown, input: any) => {
      await openingGate;
      if (candidateFailure) {throw new Error("synthetic launch candidate failure");}
      return {plan, fingerprint: launch.createFingerprint(input, plan as never, input.workspaceRef, plan.arguments),
        workspace, privatePaths: {root: {...workspace, ino: 3n, path: plan.privateRootPath}, byEnvironmentKey: {}, environmentKeys: []}};
    },
  };
const providerLaunch = {launchGuardedProvider(input: any) {
    callbacks = input;
    launchCalls += 1;
    duringLaunch?.();
    if (launchFailure) {throw new Error("synthetic launch failure");}
    launched.refs.set(input.live.attemptId, input.live.custodyRef);
    return {authority: {executable: input.live.executable, close() {}}, guardian: {}, child: {},
      exit: processExit, process: launched.get(input.live.custodyRef),
      sdkProcess: launched.start(input.live.custodyRef, input), stderr: undefined, stdout: undefined};
  }};
const spawnAcknowledgement = {acknowledgeProviderSpawn(value: LiveCustody, _guardian: unknown, options: any) {
    acknowledgement = options;
    duringAcknowledgement?.();
    // No PID observation is invented by the reservation or the synthetic launch.
    value.spawnStatus = "acknowledged";
    return Promise.resolve("acknowledged");
  }};
const containmentEvidence = {...evidence, containCustody(...args: Parameters<typeof evidence.containCustody>) {
    containmentCalls += 1;
    return containmentGate?.promise ?? evidence.containCustody(...args);
  }};
// Synthetic descriptor ownership only: retaining cleanup authority never proves start.
export const retainPrivateRootCleanupAuthority = (value: LiveCustody): number => {
  if (value.privateRootCleanupAuthority !== undefined) {return value.privateRootCleanupAuthority.descriptor;}
  assert.equal(value.spawnStatus, "never-started");
  assert.deepEqual(value.privatePaths?.root, {...workspace, ino: 3n, path: plan.privateRootPath});
  let closed = false;
  value.privateRootCleanupAuthority = Object.freeze({descriptor: 100,
    close() {if (!closed) {closed = true; closedPrivateRoots += 1;}},
  });
  return value.privateRootCleanupAuthority.descriptor;
};
const privateRoot = {quarantinePrivateRoot: () => true, quarantinePrivateRootForReconciliation: () => true};

export const {assertRetainedWorkspaceAuthority, assertReservedWorkspaceAuthority,
  closeRetainedWorkspaceAuthority, bindPrivateHostCustodyReservation} = privateReservation;
export const {verifyExecutable, resolveLaunchCandidate} = launchObservation;
export const {launchGuardedProvider} = providerLaunch;
export const {acknowledgeProviderSpawn} = spawnAcknowledgement;
export const {containCustody} = containmentEvidence;
export const {quarantinePrivateRoot, quarantinePrivateRootForReconciliation} = privateRoot;
export * from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
export * from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-evidence.js";
export const synthetic = {
  plan, workspace,
  reset() {
    candidateFailure = false; launchFailure = false; openingGate = undefined; containmentGate = undefined;
    containmentCalls = 0; closedPins = 0; closedPrivateRoots = 0; callbacks = undefined; acknowledgement = undefined;
    launchCalls = 0; duringLaunch = undefined; duringAcknowledgement = undefined; duringPinClose = undefined;
    processExit = Promise.resolve({code: 0, signal: null});
  },
  live: () => live, callbacks: () => callbacks, acknowledgement: () => acknowledgement,
  closedPrivateRoots: () => closedPrivateRoots, closedPins: () => closedPins, containmentCalls: () => containmentCalls,
  launchCalls: () => launchCalls,
  onLaunch: (callback: () => void) => {duringLaunch = callback;},
  onAcknowledgement: (callback: () => void) => {duringAcknowledgement = callback;},
  onPinClose: (callback: () => void) => {duringPinClose = callback;},
  exitWith: (promise: typeof processExit) => {processExit = promise;},
  failCandidate: () => {candidateFailure = true;}, failLaunch: () => {launchFailure = true;},
  holdOpening: (promise: Promise<void>) => {openingGate = promise;},
  holdContainment: () => {containmentGate = deferred(); return containmentGate;},
};
