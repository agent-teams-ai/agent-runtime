import { Socket } from "node:net";
import { fstatSync } from "node:fs";
import type { ContainedTurnKernelDependencies } from "../../../application/ports/outbound/contained-turn-ports.js";
import { bindDarwinAttemptOwnerBridge } from "./darwin-attempt-owner-bridge.js";
import type { DarwinAttemptRetainedOwners } from "./darwin-attempt-owner-bridge.js";

type Bridge = ReturnType<typeof bindDarwinAttemptOwnerBridge>;
declare const nativeSelectionBrand: unique symbol;
export interface DarwinNativeWorkspaceSelection { readonly [nativeSelectionBrand]: true }
type Store = ContainedTurnKernelDependencies["operationStore"];
type PrepareInput = Parameters<Store["prepareDispatch"]>[0];
type Prepared = Awaited<ReturnType<Store["prepareDispatch"]>>;
type ClaimInput = Parameters<Store["claimPreparedDispatch"]>[0];
type Claimed = Extract<Awaited<ReturnType<Store["claimPreparedDispatch"]>>, { readonly kind: "claimed" }>;
export type NativePreparedAttemptBinding = Readonly<Pick<Prepared,
  "attemptId" | "custodyId" | "executionGenerationId" | "writerFence"> & {
  operationId: PrepareInput["authority"]["operationId"];
  scope: PrepareInput["authority"]["scope"];
  workspaceId: NonNullable<PrepareInput["operation"]["workspaceId"]>;
  preparationToken: ClaimInput["subject"]["preparationToken"];
}>;
export interface RetainedNativeAttemptAuthority {
  bindPreparedAttempt(input: NativePreparedAttemptBinding): Promise<void>;
  confirmCommittedClaim(proof: Claimed["committedDispatchProof"]): Promise<void>;
}
type SelectionRecord = {
  bridge: Bridge; selected: boolean; reserved: boolean;
  prepared?: NativePreparedAttemptBinding;
  claim?: Claimed["committedDispatchProof"];
  observation?: DarwinNativeLaunchObservation;
};
const selections = new WeakMap<DarwinNativeWorkspaceSelection, SelectionRecord>();
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
  let consumed = false, claimConsumed = false;
  let prepared: NativePreparedAttemptBinding | undefined;
  let bytes: Buffer | undefined;
  return Object.freeze({
    async bindPreparedAttempt(input: NativePreparedAttemptBinding): Promise<void> {
      if (consumed) {throw new Error("native prepared binding already consumed, including uncertain binding");}
      consumed = true;
      try {
        const captured = Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
        const encoded = encodePrepared(captured);
        await bridge.bindPreparedData(encoded);
        prepared = captured; bytes = encoded; issued.prepared = captured;
      } catch (error) {bridge.lost(); throw error;}
    },
    async confirmCommittedClaim(proof: Claimed["committedDispatchProof"]): Promise<void> {
      if (claimConsumed) {throw new Error("native committed claim already consumed");}
      claimConsumed = true;
      try {
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
): Promise<Readonly<{ selection: DarwinNativeWorkspaceSelection; attemptAuthority: RetainedNativeAttemptAuthority }>> {
  if (rootConstructorConsumed) {throw new Error("native root constructor already consumed");}
  rootConstructorConsumed = true;
  if (process.platform !== "darwin" || process.argv[1] !== "--darwin-attempt-owner-bridge" ||
      !fstatSync(8).isSocket() || !process.getuid || process.getuid() === 0) {
    throw new Error("root-selected native Host inherited endpoint unavailable");
  }
  const endpoint = new Socket({ fd: 8, readable: true, writable: true });
  const bridge = bindDarwinAttemptOwnerBridge(endpoint, retainedConsumers);
  try {
    await bridge.ready;
    const manifest = bridge.capturedManifest();
    if (bridge.capturedOwner().ppid !== process.pid || manifest.readUInt32BE(16) !== process.getuid() || manifest.readUInt32BE(20) !== process.getgid?.()) {
      throw new Error("native root manifest selected another Host identity");
    }
    const selection = Object.freeze(Object.create(null)) as DarwinNativeWorkspaceSelection;
    const issued: SelectionRecord = { bridge, selected: false, reserved: false };
    selections.set(selection, issued);
    return Object.freeze({ selection, attemptAuthority: retainAttemptAuthority(issued) });
  } catch (error) {bridge.lost(); throw error;}
}
/** Private workspace facade primitive. Consumption is separate from PG binding. */
export function consumeDarwinNativeWorkspaceSelection(selection: DarwinNativeWorkspaceSelection): Bridge {
  const issued = selections.get(selection);
  if (!issued || issued.selected) {throw new Error("native workspace selection is foreign or already owned");}
  issued.selected = true;
  return issued.bridge;
}

declare const nativeObservationBrand: unique symbol;
export interface DarwinNativeLaunchObservation { readonly [nativeObservationBrand]: true }
export type NativeDirectoryFact = import("./darwin-attempt-owner-protocol.js").DarwinNativeDirectoryData;
type NativeLaunchFacts = import("./darwin-attempt-owner-protocol.js").DarwinNativeLaunchData;
const observations = new WeakMap<DarwinNativeLaunchObservation, Readonly<{ bridge: Bridge; facts: NativeLaunchFacts; generation: number }>>();

export async function readDarwinNativeLaunchObservation(selection: DarwinNativeWorkspaceSelection): Promise<DarwinNativeLaunchObservation> {
  const issued = selections.get(selection);
  if (!issued) {throw new Error("foreign native workspace selection");}
  const captured = await issued.bridge.readLaunchObservation();
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  observations.set(observation, Object.freeze({bridge: issued.bridge, ...captured}));
  issued.observation = observation;
  return observation;
}
export function assertDarwinNativeLaunchObservationCurrent(observation: DarwinNativeLaunchObservation): void {
  const issued = observations.get(observation);
  if (!issued) {throw new Error("foreign native launch observation");}
  issued.bridge.assertObservationCurrent(issued.generation);
}
export function inspectDarwinNativeLaunchObservation(observation: DarwinNativeLaunchObservation): NativeLaunchFacts {
  const issued = observations.get(observation);
  if (!issued) {throw new Error("foreign native launch observation");}
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

export async function installDarwinNativeCodexMaterial(
  selection: DarwinNativeWorkspaceSelection,
  input: Readonly<{config: Uint8Array; catalog: Uint8Array; installationId: string}>,
): Promise<DarwinNativeCodexMaterial> {
  const issued = selections.get(selection);
  if (!issued) {throw new Error("foreign native workspace selection");}
  const captured = await issued.bridge.installCodexMaterial(input);
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  observations.set(observation, Object.freeze({bridge: issued.bridge, facts: captured.facts.observation, generation: captured.generation}));
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
  const issued = selections.get(selection);
  if (!issued || issued.reserved || !issued.prepared || issued.claim || !issued.observation) {
    throw new Error("native execution selection foreign, reserved, unprepared or already claimed");
  }
  issued.bridge.assertExecutionReservable();
  assertDarwinNativeLaunchObservationCurrent(issued.observation);
  issued.reserved = true;
  const lease = Object.freeze(Object.create(null)) as DarwinNativeExecutionLease;
  const binding = issued.bridge.binding();
  const facts = Object.freeze({prepared: issued.prepared, custodyRef: binding.binding,
    hostGenerationBinding: issued.bridge.capturedManifest().subarray(144, 176).toString("hex"), observation: issued.observation});
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
/** P is retained solely by the actual private PG receiver. Validators detach
 * P to P2/P3; compare every inert field with P, never JS reference identity.
 * This assertion grants no independent lifetime and does not consume a claim. */
export function assertDarwinNativeExecutionClaim(
  lease: DarwinNativeExecutionLease, proof: Claimed["committedDispatchProof"],
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
