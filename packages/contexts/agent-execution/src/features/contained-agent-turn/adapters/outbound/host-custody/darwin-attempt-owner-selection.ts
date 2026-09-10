import { createHash } from "node:crypto";
import { join } from "node:path";
import { Socket } from "node:net";
import { fstatSync } from "node:fs";
import type { CommittedDispatchProofV1 } from "../../../domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnWriterFence } from "../../../domain/contained-turn-identities.js";
import { bindDarwinAttemptOwnerBridge } from "./darwin-attempt-owner-bridge.js";
import type { DarwinAttemptRetainedOwners } from "./darwin-attempt-owner-bridge.js";

import type { FinalHostLaunch, HostLaunchBinding } from "./host-launch-finalization.js";
import { darwinNativeArgumentsSha256, type DarwinNativeFinalLaunchData } from "./darwin-attempt-owner-protocol.js";

type Bridge = ReturnType<typeof bindDarwinAttemptOwnerBridge>;
declare const nativeSelectionBrand: unique symbol;
export interface DarwinNativeWorkspaceSelection { readonly [nativeSelectionBrand]: true }
export type NativePreparedAttemptBinding = Readonly<Pick<CommittedDispatchProofV1,
  "operationId" | "attemptId" | "custodyId" | "executionGenerationId" | "workspaceId" | "preparationToken"> & {
  scope: Readonly<Pick<CommittedDispatchProofV1, "tenantId" | "projectId">>;
  writerFence: ContainedTurnWriterFence;
}>;
export interface RetainedNativeAttemptAuthority {
  bindPreparedAttempt(input: NativePreparedAttemptBinding): Promise<void>;
  confirmCommittedClaim(proof: CommittedDispatchProofV1): Promise<void>;
}
type SelectionRecord = {
  bridge: Bridge; selected: boolean; reserved: boolean; claimStarted: boolean;
  revoked?: boolean; borrowConsumed?: boolean;
  prepared?: NativePreparedAttemptBinding;
  claim?: CommittedDispatchProofV1;
  observation?: DarwinNativeLaunchObservation;
  finalConsumed?: boolean;
  started?: boolean;
  final?: Readonly<{binding: HostLaunchBinding; launch: FinalHostLaunch; material: DarwinNativeCodexMaterial;
    bindingClass: typeof HostLaunchBinding}>;
};
const selections = new WeakMap<DarwinNativeWorkspaceSelection, SelectionRecord>();
type NativeBorrow = {issued: SelectionRecord; active: boolean};
const borrows = new WeakMap<DarwinNativeWorkspaceSelection, NativeBorrow>();
function assertOwnerCurrent(issued: SelectionRecord, borrow?: NativeBorrow): void {
  if (issued.revoked || (borrow && !borrow.active)) {throw new Error("native admission revoked or borrow expired");}
}
function selectionAuthority(selection: DarwinNativeWorkspaceSelection): {issued: SelectionRecord; borrow?: NativeBorrow} {
  const borrow = borrows.get(selection), issued = selections.get(selection) ?? borrow?.issued;
  if (!issued) {throw new Error("foreign native workspace selection");}
  assertOwnerCurrent(issued, borrow);
  return borrow ? {issued, borrow} : {issued};
}
export async function withDarwinNativeWorkspaceSelection<Result>(
  selection: DarwinNativeWorkspaceSelection,
  ids: Readonly<{operationId: string; workspaceId: string; attemptId: string}>,
  consume: (borrow: DarwinNativeWorkspaceSelection) => Promise<Result>,
): Promise<Result> {
  const {issued} = selectionAuthority(selection), prepared = issued.prepared;
  if (!prepared || issued.borrowConsumed || issued.claimStarted || typeof consume !== "function" ||
      ids.operationId !== prepared.operationId || ids.workspaceId !== prepared.workspaceId || ids.attemptId !== prepared.attemptId) {
    throw new Error("native workspace borrow unavailable or prepared tuple differs");
  }
  issued.bridge.assertExecutionReservable();
  issued.borrowConsumed = true;
  const borrow = Object.freeze(Object.create(null)) as DarwinNativeWorkspaceSelection;
  const retained: NativeBorrow = {issued, active: true}; borrows.set(borrow, retained);
  try {return await consume(borrow);}
  finally {retained.active = false;}
}
export function revokeDarwinNativeWorkspaceSelection(selection: DarwinNativeWorkspaceSelection): void {
  const issued = selections.get(selection);
  if (!issued) {throw new Error("native revocation requires actual retained root selection");}
  issued.revoked = true;
  issued.bridge.revokeAdmission();
}
let rootConstructorConsumed = false;
const encodePrepared = (input: NativePreparedAttemptBinding): Buffer => {
  const fields = [input.operationId, input.scope.tenantId, input.scope.projectId, input.workspaceId,
    input.attemptId, input.custodyId, input.executionGenerationId, input.writerFence, input.preparationToken];
  const bytes = Buffer.alloc(9252);
  for (const [index, field] of fields.entries()) {
    if (typeof field !== "string" || field.length === 0 || field.includes("\0") || field !== field.normalize("NFC") || Buffer.byteLength(field) > 1024) {
      throw new Error("invalid actual prepared attempt binding");
    }
    const encoded = Buffer.from(field, "utf8"); bytes.writeUInt32BE(encoded.length, index * 1028); encoded.copy(bytes, index * 1028 + 4);
  }
  return bytes;
};
const retainAttemptAuthority = (issued: SelectionRecord): RetainedNativeAttemptAuthority => {
  const { bridge } = issued;
  let consumed = false;
  let prepared: NativePreparedAttemptBinding | undefined;
  let bytes: Buffer | undefined;
  return Object.freeze({
    async bindPreparedAttempt(input: NativePreparedAttemptBinding): Promise<void> {
      if (consumed) {throw new Error("native prepared binding already consumed, including uncertain binding");}
      consumed = true;
      try {
        assertOwnerCurrent(issued);
        const captured = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
        const encoded = encodePrepared(captured);
        await bridge.bindPreparedData(encoded);
        assertOwnerCurrent(issued);
        prepared = captured; bytes = encoded; issued.prepared = captured;
      } catch (error) {bridge.lost(); throw error;}
    },
    async confirmCommittedClaim(proof: CommittedDispatchProofV1): Promise<void> {
      if (issued.claimStarted) {throw new Error("native committed claim already consumed");}
      issued.claimStarted = true;
      try {
        assertOwnerCurrent(issued);
        const bound = prepared;
        if (!Object.isFrozen(proof) || Object.getPrototypeOf(proof) !== Object.prototype ||
            Reflect.ownKeys(proof).some(key => typeof key !== "string") ||
            Object.values(Object.getOwnPropertyDescriptors(proof)).some(field => !("value" in field) ||
              (typeof field.value !== "string" && typeof field.value !== "number"))) {
          throw new Error("committed claim must be the retained immutable data record");
        }
        if (!bound || !bytes || proof.purpose !== "contained_turn_committed_dispatch_v1" || proof.version !== 1 ||
            proof.operationId !== bound.operationId || proof.attemptId !== bound.attemptId || proof.custodyId !== bound.custodyId ||
            proof.executionGenerationId !== bound.executionGenerationId || proof.workspaceId !== bound.workspaceId ||
            proof.preparationToken !== bound.preparationToken || proof.tenantId !== bound.scope.tenantId || proof.projectId !== bound.scope.projectId) {
          throw new Error("actual committed claim does not bind the prepared native attempt");
        }
        // Receiver ownership, retained exclusively by the actual outer PG store
        // wrapper, is the authority. Full proof bytes are journaled as evidence;
        // a caller digest can neither register nor reconstruct this receiver.
        const payload = Buffer.concat([bytes, Buffer.from(JSON.stringify(proof), "utf8")]);
        await bridge.confirmClaimData(payload);
        assertOwnerCurrent(issued);
        issued.claim = proof;
      } catch (error) {bridge.lost(); throw error;}
    },
  });
};
/** Trusted root-selected Host entrypoint only. No fd/path/bridge or workspace
 * proof callback registration argument exists. Root supplies fixed socket FD 8
 * by exec; native peer validates the selected Host birth/image on each command.
 * The returned receiver belongs ONLY to the actual Lane4 outer store wrapper.
 * It is deliberately absent from the opaque workspace selection. */
export async function captureRootDarwinAttemptWorkspace(
  retainedConsumers: DarwinAttemptRetainedOwners,
): Promise<Readonly<{ selection: DarwinNativeWorkspaceSelection; attemptAuthority: RetainedNativeAttemptAuthority;
  httpLaunchAuthority: RetainedNativeHttpLaunchAuthority }>> {
  if (rootConstructorConsumed) {throw new Error("native root constructor already consumed");}
  rootConstructorConsumed = true;
  if (process.platform !== "darwin" || process.argv[2] !== "--darwin-attempt-owner-bridge" ||
      !fstatSync(8).isSocket() || !process.getuid || process.getuid() === 0) {
    throw new Error("root-selected native Host inherited endpoint unavailable");
  }
  const endpoint = new Socket({ fd: 8, readable: true, writable: true });
  const bridge = bindDarwinAttemptOwnerBridge(endpoint, retainedConsumers);
  try {
    await bridge.ready;
    // Fixed trusted dependency in the pinned Host closure, never a caller path
    // or validator callback. It observes Darwin FD8 credentials and actual
    // creator/child birth-image state, consuming root challenge FD11 once.
    const peerModule = {exports: {} as {verifyRootPeer(packet: Buffer): boolean}};
    process.dlopen(peerModule, join(import.meta.dirname, "native", "darwin-attempt-owner-peer.node"));
    if (peerModule.exports.verifyRootPeer(bridge.capturedPeerPacket()) !== true) {
      throw new Error("native root peer verifier did not admit this owner");
    }
    const manifest = bridge.capturedManifest();
    const entrypoint = manifest.subarray(304 + 5 * 288, 304 + 5 * 288 + 256);
    const terminator = entrypoint.indexOf(0);
    if (terminator <= 0 || process.argv[1] !== entrypoint.subarray(0, terminator).toString("utf8")) {
      throw new Error("native root packet selected another Host entrypoint");
    }
    if (bridge.capturedOwner().ppid !== process.pid || manifest.readUInt32BE(16) !== process.getuid() || manifest.readUInt32BE(20) !== process.getgid?.()) {
      throw new Error("native root manifest selected another Host identity");
    }
    const selection = Object.freeze(Object.create(null)) as DarwinNativeWorkspaceSelection;
    const issued: SelectionRecord = { bridge, selected: false, reserved: false, claimStarted: false };
    selections.set(selection, issued);
    return Object.freeze({ selection, attemptAuthority: retainAttemptAuthority(issued),
      httpLaunchAuthority: retainHttpLaunchAuthority(issued) });
  } catch (error) {bridge.lost(); throw error;}
}
/** Private workspace facade primitive. Consumption is separate from PG binding. */
export type DarwinNativeWorkspacePrimitives = Pick<Bridge,
  "materializeComplete" | "readCompleteTree" | "commitCreation" | "freezeWorkspace" |
  "cleanupWorkspace" | "closeWorkspace" | "settleArtifactResult" | "settleWorkspace" |
  "readClosedWorkspace" | "queryClosedWorkspace" | "retainedClosed" | "binding" | "capturedManifest" | "lost">;
export function consumeDarwinNativeWorkspaceSelection(selection: DarwinNativeWorkspaceSelection): DarwinNativeWorkspacePrimitives {
  const issued = selections.get(selection);
  if (!issued || issued.selected) {throw new Error("native workspace selection is foreign or already owned");}
  assertOwnerCurrent(issued);
  issued.selected = true;
  const bridge = issued.bridge;
  // A runtime projection, not a type assertion over the raw bridge: workspace
  // possession must never expose PG bind/claim or native execution commands.
  return Object.freeze({
    materializeComplete: bridge.materializeComplete, readCompleteTree: bridge.readCompleteTree,
    commitCreation: bridge.commitCreation, freezeWorkspace: bridge.freezeWorkspace,
    cleanupWorkspace: bridge.cleanupWorkspace, closeWorkspace: bridge.closeWorkspace,
    settleArtifactResult: bridge.settleArtifactResult, settleWorkspace: bridge.settleWorkspace,
    queryClosedWorkspace: bridge.queryClosedWorkspace, readClosedWorkspace: bridge.readClosedWorkspace, retainedClosed: bridge.retainedClosed,
    binding: bridge.binding, capturedManifest: bridge.capturedManifest, lost: bridge.lost,
  });
}

declare const nativeObservationBrand: unique symbol;
export interface DarwinNativeLaunchObservation { readonly [nativeObservationBrand]: true }
export type NativeDirectoryFact = import("./darwin-attempt-owner-protocol.js").DarwinNativeDirectoryData;
type NativeLaunchFacts = import("./darwin-attempt-owner-protocol.js").DarwinNativeLaunchData;
const observations = new WeakMap<DarwinNativeLaunchObservation, Readonly<{ bridge: Bridge; issued: SelectionRecord; borrow?: NativeBorrow; facts: NativeLaunchFacts; generation: number }>>();

type NativeAuthority = DarwinNativeWorkspaceSelection | DarwinNativeExecutionLease;
function retainedAuthority(authority: NativeAuthority): {issued: SelectionRecord; borrow?: NativeBorrow} {
  const lease = leases.get(authority as DarwinNativeExecutionLease);
  if (!lease) {return selectionAuthority(authority as DarwinNativeWorkspaceSelection);}
  assertDarwinNativeExecutionLeaseCurrent(authority as DarwinNativeExecutionLease);
  return {issued: lease.issued};
}
export async function readDarwinNativeLaunchObservation(selection: DarwinNativeWorkspaceSelection): Promise<DarwinNativeLaunchObservation>;
export async function readDarwinNativeLaunchObservation(lease: DarwinNativeExecutionLease): Promise<DarwinNativeLaunchObservation>;
export async function readDarwinNativeLaunchObservation(authority: NativeAuthority): Promise<DarwinNativeLaunchObservation> {
  const {issued, borrow} = retainedAuthority(authority);
  const captured = await issued.bridge.readLaunchObservation();
  assertOwnerCurrent(issued, borrow);
  issued.bridge.assertObservationCurrent(captured.generation);
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  observations.set(observation, Object.freeze(borrow
    ? {bridge: issued.bridge, issued, borrow, ...captured}
    : {bridge: issued.bridge, issued, ...captured}));
  if (!borrow) {issued.observation = observation;}
  return observation;
}
export function assertDarwinNativeLaunchObservationCurrent(observation: DarwinNativeLaunchObservation): void {
  const issued = observations.get(observation);
  if (!issued) {throw new Error("foreign native launch observation");}
  assertOwnerCurrent(issued.issued, issued.borrow);
  issued.bridge.assertObservationCurrent(issued.generation);
}
export function inspectDarwinNativeLaunchObservation(observation: DarwinNativeLaunchObservation): NativeLaunchFacts {
  const issued = observations.get(observation);
  if (!issued) {throw new Error("foreign native launch observation");}
  assertOwnerCurrent(issued.issued, issued.borrow);
  issued.bridge.assertObservationCurrent(issued.generation);
  return issued.facts;
}

declare const nativeMaterialBrand: unique symbol;
export interface DarwinNativeCodexMaterial { readonly [nativeMaterialBrand]: true }
export type NativeFileFact = import("./darwin-attempt-owner-protocol.js").DarwinNativeFileData;
type NativeMaterialFacts = Readonly<{
  observation: DarwinNativeLaunchObservation; config: NativeFileFact; catalog: NativeFileFact;
  installation: NativeFileFact; installationId: string;
}>;
const materials = new WeakMap<DarwinNativeCodexMaterial, NativeMaterialFacts>();

type NativeMaterialInput = Readonly<{config: Uint8Array; catalog: Uint8Array; installationId: string}>;
export async function installDarwinNativeCodexMaterial(selection: DarwinNativeWorkspaceSelection, input: NativeMaterialInput): Promise<DarwinNativeCodexMaterial>;
export async function installDarwinNativeCodexMaterial(lease: DarwinNativeExecutionLease, input: NativeMaterialInput): Promise<DarwinNativeCodexMaterial>;
export async function installDarwinNativeCodexMaterial(authority: NativeAuthority, input: NativeMaterialInput): Promise<DarwinNativeCodexMaterial> {
  const {issued, borrow} = retainedAuthority(authority);
  if (!issued.claim) {throw new Error("native material requires actual retained committed claim");}
  const captured = await issued.bridge.installCodexMaterial(input);
  assertOwnerCurrent(issued, borrow);
  issued.bridge.assertObservationCurrent(captured.generation);
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  const retainedObservation = {bridge: issued.bridge, issued, facts: captured.facts.observation, generation: captured.generation};
  observations.set(observation, Object.freeze(borrow ? {...retainedObservation, borrow} : retainedObservation));
  const material = Object.freeze(Object.create(null)) as DarwinNativeCodexMaterial;
  materials.set(material, Object.freeze({observation, config: captured.facts.config, catalog: captured.facts.catalog,
    installation: captured.facts.installation, installationId: captured.installationId}));
  return material;
}
export function inspectDarwinNativeCodexMaterial(material: DarwinNativeCodexMaterial): NativeMaterialFacts {
  const issued = materials.get(material);
  if (!issued) {throw new Error("foreign native material capability");}
  assertDarwinNativeLaunchObservationCurrent(issued.observation);
  return issued;
}
export function assertDarwinNativeCodexMaterialCurrent(material: DarwinNativeCodexMaterial): void {
  inspectDarwinNativeCodexMaterial(material);
}

declare const nativeExecutionLeaseBrand: unique symbol;
export interface DarwinNativeExecutionLease { readonly [nativeExecutionLeaseBrand]: true }
export type DarwinNativeExecutionLeaseFacts = Readonly<{
  prepared: NativePreparedAttemptBinding;
  custodyRef: string;
  hostGenerationBinding: string;
  observation: DarwinNativeLaunchObservation;
}>;
const leases = new WeakMap<DarwinNativeExecutionLease, Readonly<{
  issued: SelectionRecord; facts: DarwinNativeExecutionLeaseFacts;
}>>();

/** Separate from workspace selection consumption. Only the retained PG receiver
 * can populate prepared/claim state; structural proof cannot reserve a lease. */
export function reserveDarwinNativeExecution(selection: DarwinNativeWorkspaceSelection): DarwinNativeExecutionLease {
  const {issued, borrow} = selectionAuthority(selection);
  if (!borrow || issued.reserved || !issued.prepared || issued.claimStarted || !issued.observation) {
    throw new Error("native execution selection foreign, reserved, unprepared or already claimed");
  }
  issued.bridge.assertExecutionReservable();
  assertDarwinNativeLaunchObservationCurrent(issued.observation);
  issued.reserved = true;
  const lease = Object.freeze(Object.create(null)) as DarwinNativeExecutionLease;
  const binding = issued.bridge.binding();
  const original = observations.get(issued.observation)!;
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  observations.set(observation, Object.freeze({bridge: original.bridge, issued: original.issued,
    facts: original.facts, generation: original.generation}));
  const facts = Object.freeze({prepared: issued.prepared, custodyRef: binding.binding,
    hostGenerationBinding: issued.bridge.capturedManifest().subarray(144, 176).toString("hex"), observation});
  leases.set(lease, Object.freeze({issued, facts}));
  return lease;
}
export function assertDarwinNativeExecutionLeaseCurrent(lease: DarwinNativeExecutionLease): void {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  assertDarwinNativeLaunchObservationCurrent(retained.facts.observation);
}
export function inspectDarwinNativeExecutionLease(lease: DarwinNativeExecutionLease): DarwinNativeExecutionLeaseFacts {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  assertDarwinNativeExecutionLeaseCurrent(lease);
  return retained.facts;
}
export function assertDarwinNativeSelectionExecutionLease(
  selection: DarwinNativeWorkspaceSelection, lease: DarwinNativeExecutionLease,
): void {
  const issued = selections.get(selection); const retained = leases.get(lease);
  if (issued === undefined || retained?.issued !== issued) {throw new Error("foreign native execution lease owner");}
  assertDarwinNativeExecutionLeaseCurrent(lease);
}
/** P is retained solely by the actual private PG receiver. Validators detach
 * P to P2/P3; compare every inert field with P, never JS reference identity.
 * This assertion grants no independent lifetime and does not consume a claim. */
export function assertDarwinNativeExecutionClaim(
  lease: DarwinNativeExecutionLease, proof: CommittedDispatchProofV1,
): void {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  assertDarwinNativeExecutionLeaseCurrent(lease);
  const actual = retained.issued.claim;
  if (!actual) {throw new Error("native execution has no retained actual committed claim");}
  if (!proof || typeof proof !== "object" || Object.getPrototypeOf(proof) !== Object.prototype) {
    throw new Error("native claim must be inert detached proof data");
  }
  const expected = Object.getOwnPropertyDescriptors(actual), observed = Object.getOwnPropertyDescriptors(proof);
  const keys = Reflect.ownKeys(proof);
  if (keys.length !== Reflect.ownKeys(actual).length || keys.some(key => {
    if (typeof key !== "string") {return true;}
    const a = expected[key], b = observed[key];
    return !a || !b || !("value" in b) || b.value !== a.value;
  })) {throw new Error("native detached claim differs from actual committed binding");}
}

export type DarwinNativeExecutionObservation = ReturnType<Bridge["execution"]>;
export type DarwinNativeExecutionStatus = Awaited<ReturnType<Bridge["status"]>>;
/** Observations remain readable after cutoff; missing native evidence stays
 * undefined. Neither lease validity nor helper shutdown fabricates an exit. */
export function readDarwinNativeExecution(lease: DarwinNativeExecutionLease): DarwinNativeExecutionObservation {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  return retained.issued.bridge.execution();
}
export async function readDarwinNativeExecutionStatus(lease: DarwinNativeExecutionLease): Promise<DarwinNativeExecutionStatus> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  return retained.issued.bridge.status();
}
export async function cutoffDarwinNativeExecution(lease: DarwinNativeExecutionLease): Promise<DarwinNativeExecutionStatus> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  return retained.issued.bridge.cutoff();
}

/** These use the original root-retained consumers. A caller cannot substitute
 * settlement data or a callback, and a cut-off lease still owes cleanup. */
export async function settleDarwinNativeExecutionLaunchRoute(lease: DarwinNativeExecutionLease): Promise<void> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  await retained.issued.bridge.settleLaunchRoute();
}
export async function settleDarwinNativeExecutionPrivateMaterial(lease: DarwinNativeExecutionLease): Promise<void> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  await retained.issued.bridge.settlePrivateMaterial();
}
export type DarwinNativeExecutionDisposal = Awaited<ReturnType<Bridge["disposePrivate"]>>;
export async function disposeDarwinNativeExecution(lease: DarwinNativeExecutionLease): Promise<DarwinNativeExecutionDisposal> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  return retained.issued.bridge.disposePrivate();
}


/** Root passes this receiver exclusively to the actual native HTTP owner,
 * separately from workspace selection and the actual PG receiver. No public
 * register-final API or caller validation callback exists on the lease. */
export interface RetainedNativeHttpLaunchAuthority {
  bindDarwinNativeFinalLaunch(
    lease: DarwinNativeExecutionLease, finalLaunch: FinalHostLaunch, actualBinding: HostLaunchBinding,
    material: DarwinNativeCodexMaterial, preparedListenerPort: number,
  ): Promise<void>;
}
function assertActualFinalBinding(bindingClass: typeof HostLaunchBinding, binding: HostLaunchBinding, launch: FinalHostLaunch): void {
  // Invoke the real class's private-field accessors directly. A duck-typed view,
  // subclass override or caller-supplied assertStart cannot establish authority.
  const current = Object.getOwnPropertyDescriptor(bindingClass.prototype, "current")!.get!;
  const material = Object.getOwnPropertyDescriptor(bindingClass.prototype, "materialSha256")!.get!;
  if (current.call(binding) !== launch || material.call(binding) !== launch.materialSha256 ||
      material.call(binding) === undefined) {throw new Error("final launch is not the actual committed Host binding");}
  bindingClass.prototype.assertStart.call(binding, launch);
  if (binding.view.readFinal() !== launch) {throw new Error("final Host launch view changed");}
}
function assertFinalNativeDirectories(
  launch: FinalHostLaunch, facts: ReturnType<typeof inspectDarwinNativeLaunchObservation>,
): void {
  const plan = launch.plan;
  const environment = plan.environment;
  const keys = ["AR_PRIVATE_BROKER_CAPABILITY", "CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR"];
  if (Object.keys(environment).toSorted().join() !== keys.join() || environment.PATH !== "/usr/bin:/bin" ||
      environment.LANG !== "C.UTF-8" || environment.HOME !== facts.privateRoot.path ||
      environment.CODEX_HOME !== facts.codexHome.path || environment.TMPDIR !== facts.tmpDir.path ||
      plan.privateRootPath !== facts.privateRoot.path || launch.canonicalWorkspace !== facts.workspace.path ||
      launch.workspace.dev !== facts.workspace.dev || launch.workspace.ino !== facts.workspace.ino ||
      launch.workspace.uid !== BigInt(facts.leasedUid) || plan.provider !== "codex") {
    throw new Error("final Host launch differs from native root/environment binding");
  }
  for (const [key, fact] of [["HOME", facts.privateRoot], ["CODEX_HOME", facts.codexHome], ["TMPDIR", facts.tmpDir]] as const) {
    const actual = launch.privatePaths.byEnvironmentKey[key];
    if (!actual || actual.path !== fact.path || actual.dev !== fact.dev || actual.ino !== fact.ino || actual.uid !== BigInt(fact.uid)) {
      throw new Error("final Host launch changed native private directory identity");
    }
  }
}
function finalLaunchData(
  issued: SelectionRecord, launch: FinalHostLaunch, material: DarwinNativeCodexMaterial, port: number,
): DarwinNativeFinalLaunchData {
  const installed = inspectDarwinNativeCodexMaterial(material);
  const materialObservation = observations.get(installed.observation);
  const prepared = issued.prepared;
  if (!prepared || !issued.claim || materialObservation?.bridge !== issued.bridge) {
    throw new Error("final launch lacks this attempt's actual claim/material");
  }
  const facts = inspectDarwinNativeLaunchObservation(installed.observation), plan = launch.plan;
  assertFinalNativeDirectories(launch, facts);
  const environment = plan.environment;
  const manifest = issued.bridge.capturedManifest();
  const provider = manifest.subarray(304 + 2 * 288, 304 + 2 * 288 + 256);
  if (plan.executablePath !== provider.subarray(0, provider.indexOf(0)).toString("utf8") ||
      plan.executableSha256 !== manifest.subarray(304 + 2 * 288 + 256, 304 + 3 * 288).toString("hex") ||
      launch.executable.digest !== plan.executableSha256) {throw new Error("final provider differs from root image");}
  return Object.freeze({home: facts.privateRoot.path, codexHome: facts.codexHome.path, tmpDir: facts.tmpDir.path,
    localCapability: environment.AR_PRIVATE_BROKER_CAPABILITY!, port,
    preparedSha256: createHash("sha256").update(encodePrepared(prepared)).digest("hex"),
    profileSha256: manifest.subarray(304 + 4 * 288 + 256, 304 + 5 * 288).toString("hex"),
    configSha256: installed.config.sha256, catalogSha256: installed.catalog.sha256,
    installationSha256: installed.installation.sha256, fingerprintSha256: launch.fingerprint.fingerprintSha256,
    materialSha256: launch.materialSha256, executableSha256: plan.executableSha256,
    argumentsSha256: darwinNativeArgumentsSha256(plan.executablePath, plan.arguments)});
}
function retainHttpLaunchAuthority(issued: SelectionRecord): RetainedNativeHttpLaunchAuthority {
  const authority = Object.freeze({
    async bindDarwinNativeFinalLaunch(lease: DarwinNativeExecutionLease, launch: FinalHostLaunch,
      binding: HostLaunchBinding, material: DarwinNativeCodexMaterial, port: number): Promise<void> {
      const retained = leases.get(lease);
      if (!retained || retained.issued !== issued) {throw new Error("foreign native HTTP execution lease");}
      if (issued.finalConsumed) {throw new Error("native HTTP final launch already consumed");}
      issued.finalConsumed = true;
      try {
        assertDarwinNativeExecutionLeaseCurrent(lease);
        if (!issued.claim) {throw new Error("native final launch requires actual committed claim");}
        const installed = materials.get(material);
        if (!installed || observations.get(installed.observation)?.bridge !== issued.bridge) {
          throw new Error("foreign native final material");
        }
        // Late fixed import avoids a startup cycle with the actual HTTP owner.
        // It imports real production binding code, never a caller validator.
        const {HostLaunchBinding: bindingClass} = await import("./host-launch-finalization.js");
        assertDarwinNativeExecutionLeaseCurrent(lease);
        assertActualFinalBinding(bindingClass, binding, launch);
        const data = finalLaunchData(issued, launch, material, port);
        await issued.bridge.captureFinalLaunch(data);
        assertDarwinNativeExecutionLeaseCurrent(lease);
        assertDarwinNativeCodexMaterialCurrent(material);
        assertActualFinalBinding(bindingClass, binding, launch);
        issued.final = Object.freeze({binding, launch, material, bindingClass});
      } catch (error) {issued.bridge.lost(); throw error;}
    },
  });
  httpAuthorities.set(authority, issued);
  return authority;
}
const httpAuthorities = new WeakMap<RetainedNativeHttpLaunchAuthority, SelectionRecord>();
export function assertRetainedDarwinNativeHttpExecutionAuthority(
  authority: RetainedNativeHttpLaunchAuthority, lease: DarwinNativeExecutionLease,
): void {
  const issued = httpAuthorities.get(authority); const retained = leases.get(lease);
  if (issued === undefined || retained?.issued !== issued) {throw new Error("foreign native HTTP execution authority");}
  assertDarwinNativeExecutionLeaseCurrent(lease);
}
export async function bindRetainedDarwinNativeHttpLaunch(
  authority: RetainedNativeHttpLaunchAuthority, lease: DarwinNativeExecutionLease,
  launch: FinalHostLaunch, binding: HostLaunchBinding, material: DarwinNativeCodexMaterial, port: number,
): Promise<void> {
  assertRetainedDarwinNativeHttpExecutionAuthority(authority, lease);
  await authority.bindDarwinNativeFinalLaunch(lease, launch, binding, material, port);
}
export type DarwinNativeExecutionStart = Awaited<ReturnType<Bridge["startProcess"]>>;
/** Parameterless beyond the same issued lease. Nothing caller-shaped can
 * replace the once-captured final environment, provider argv or native route. */
export async function startDarwinNativeExecution(lease: DarwinNativeExecutionLease): Promise<DarwinNativeExecutionStart> {
  const retained = leases.get(lease);
  if (!retained) {throw new Error("foreign native execution lease");}
  const issued = retained.issued, final = issued.final;
  if (!final || issued.started) {throw new Error("native final launch unavailable or already started");}
  issued.started = true;
  try {
    assertDarwinNativeExecutionLeaseCurrent(lease);
    assertDarwinNativeCodexMaterialCurrent(final.material);
    assertActualFinalBinding(final.bindingClass, final.binding, final.launch);
    return await issued.bridge.startProcess();
  } catch (error) {issued.bridge.lost(); throw error;}
}
