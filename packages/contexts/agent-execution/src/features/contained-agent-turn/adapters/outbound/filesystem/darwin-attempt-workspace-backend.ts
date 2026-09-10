import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { fstatSync } from "node:fs";
import type { ContainedTurnWorkspaceTree, ContainedTurnWorkspaceTreeLimits } from "./contained-turn-workspace-tree.js";
import type { DarwinAttemptRetainedOwners } from "../host-custody/darwin-attempt-owner-bridge.ts";
import type { ContainedTurnKernelDependencies } from "../../../application/ports/outbound/contained-turn-ports.js";
import { darwinAttemptOwnerStates } from "../host-custody/darwin-attempt-owner-protocol.ts";
import { bindDarwinAttemptOwnerBridge } from "../host-custody/darwin-attempt-owner-bridge.ts";
import { createWorkspaceClosureRecord } from "./contained-turn-workspace-state.ts";
import type {
  ContainedTurnWorkspaceCreationRecord, ContainedTurnWorkspaceSealRecord,
  ContainedTurnWorkspaceClosureRecord,
} from "./contained-turn-workspace-state.ts";

type Bridge = ReturnType<typeof bindDarwinAttemptOwnerBridge>;
/** Private backend beneath the existing workspace owner. That owner retains
 * its creation/seal/closure records and receipt authority. Root composition
 * binds these callbacks to that selected instance, never a caller record API. */
export interface DarwinNativeRetainedWorkspaceOwners {
  readonly creation: () => Promise<ContainedTurnWorkspaceCreationRecord>;
  readonly seal: () => Promise<ContainedTurnWorkspaceSealRecord>;
  readonly closure: () => Promise<ContainedTurnWorkspaceClosureRecord>;
  readonly artifactResult: () => Promise<Readonly<Pick<ContainedTurnWorkspaceSealRecord,
    "operationId" | "scope" | "treeDigest" | "manifestDigest">>>;
}
function createDarwinAttemptWorkspaceBackend(bridge: Bridge, selected: DarwinNativeRetainedWorkspaceOwners) {
  const records = Object.freeze({ creation: selected.creation, seal: selected.seal,
    closure: selected.closure, artifactResult: selected.artifactResult });
  let materialized: ContainedTurnWorkspaceTree | undefined;
  let creationCommitted = false;
  const identity = async (): Promise<ContainedTurnWorkspaceCreationRecord> => {
    const creation = await records.creation();
    const native = bridge.binding();
    const manifest = bridge.capturedManifest();
    const operation = createHash("sha256").update(creation.operationId).digest();
    const scope = createHash("sha256").update(creation.scope.tenantId).update(Buffer.alloc(1)).update(creation.scope.projectId).digest();
    if (!operation.equals(manifest.subarray(48, 80)) || !scope.equals(manifest.subarray(80, 112))) {
      throw new Error("workspace creation does not match root operation/scope reservation");
    }
    if (creation.schemaVersion !== 1 || creation.rootIdentity.dev !== native.workspaceDev ||
        creation.rootIdentity.ino !== native.workspaceIno ||
        !materialized || creation.materializationDigest !== materialized.treeDigest) {throw new Error("native workspace is not the original creation inode");}
    return creation;
  };
  const seal = async (): Promise<ContainedTurnWorkspaceSealRecord> => {
    const creation = await identity();
    const sealed = await records.seal();
    if (sealed.schemaVersion !== 2 || sealed.operationId !== creation.operationId ||
        sealed.workspaceName !== creation.workspaceName || sealed.scope.projectId !== creation.scope.projectId ||
        sealed.scope.tenantId !== creation.scope.tenantId || sealed.rootIdentity.dev !== creation.rootIdentity.dev ||
        sealed.rootIdentity.ino !== creation.rootIdentity.ino) {throw new Error("workspace seal belongs to another retained root");}
    return sealed;
  };
  const closure = async (): Promise<ContainedTurnWorkspaceClosureRecord> => {
    const sealed = await seal();
    const closed = await records.closure();
    if (closed.schemaVersion !== 3 || closed.operationId !== sealed.operationId || closed.workspaceName !== sealed.workspaceName ||
        closed.scope.projectId !== sealed.scope.projectId || closed.scope.tenantId !== sealed.scope.tenantId ||
        closed.treeDigest !== sealed.treeDigest || closed.manifestDigest !== sealed.manifestDigest ||
        closed.receiptRef !== createWorkspaceClosureRecord(sealed.workspaceName, sealed).receiptRef) {
      throw new Error("workspace closure does not match the original seal");
    }
    return closed;
  };
  return Object.freeze({
    async materializeComplete(source: ContainedTurnWorkspaceTree, limits: ContainedTurnWorkspaceTreeLimits): Promise<ContainedTurnWorkspaceTree> {
      materialized = await bridge.materializeComplete(source, limits); return materialized;
    },
    async commitCreation(): Promise<void> {
      if (creationCommitted) {throw new Error("native creation acknowledgement already consumed");}
      creationCommitted = true;
      const creation = await identity();
      await bridge.commitCreation(creation.materializationDigest, creation.operationId, creation.scope);
    },
    async freeze() {
      await identity();
      const native = await bridge.freezeWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.frozen) {throw new Error("native workspace was not frozen");}
      return bridge.readCompleteTree();
    },
    async cleanup(): Promise<void> {
      const sealed = await seal();
      const published = await records.artifactResult();
      if (published.operationId !== sealed.operationId || published.scope.projectId !== sealed.scope.projectId ||
          published.scope.tenantId !== sealed.scope.tenantId || published.treeDigest !== sealed.treeDigest ||
          published.manifestDigest !== sealed.manifestDigest) {throw new Error("native artifact/result publication mismatch");}
      await bridge.settleArtifactResult();
      const native = await bridge.cleanupWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.cleanup) {throw new Error("native workspace cleanup move is unknown");}
    },
    async close(): Promise<void> {
      await seal();
      const native = await bridge.closeWorkspace();
      if (native.workspace !== darwinAttemptOwnerStates.workspace.closed) {throw new Error("native workspace close move is unknown");}
      // The existing owner publishes its ordinary closure record after this
      // original-inode move, before invoking acknowledgeClosure below.
    },
    async acknowledgeClosure(): Promise<void> {
      await closure(); await bridge.settleWorkspace();
    },
    async quarantine(): Promise<void> {
      bridge.lost(); throw new Error("native quarantine disposition is indeterminate; retained custody requires reconciliation");
    },
    async readClosed(): Promise<ContainedTurnWorkspaceClosureRecord> {
      const known = bridge.retainedClosed();
      if (!known) {throw new Error("no successfully closed native owner to replay");}
      const closed = await closure();
      const observed = await bridge.readClosedWorkspace();
      const readback = observed.event;
      if (observed.tree.treeDigest !== closed.treeDigest) {throw new Error("closed native tree differs from retained seal");}
      if (readback.binding !== known.binding || readback.launch !== known.launch ||
          readback.workspaceDev !== known.workspaceDev || readback.workspaceIno !== known.workspaceIno ||
          !readback.payload.equals(known.payload)) {throw new Error("closed native record/inode readback mismatch");}
      return closed;
    },
  });
}

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
const selections = new WeakMap<DarwinNativeWorkspaceSelection, { bridge: Bridge; selected: boolean }>();
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
const retainAttemptAuthority = (bridge: Bridge): RetainedNativeAttemptAuthority => {
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
        prepared = captured; bytes = encoded;
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
    selections.set(selection, { bridge, selected: false });
    return Object.freeze({ selection, attemptAuthority: retainAttemptAuthority(bridge) });
  } catch (error) {bridge.lost(); throw error;}
}
/** Called only inside the actual Lane3 workspace owner constructor. Provenance
 * lookup precedes property reads; structural clones cannot select a backend. */
export function selectDarwinAttemptWorkspaceBackend(
  selection: DarwinNativeWorkspaceSelection,
  retainedOwners: DarwinNativeRetainedWorkspaceOwners,
): ReturnType<typeof createDarwinAttemptWorkspaceBackend> {
  const issued = selections.get(selection);
  if (!issued || issued.selected) {throw new Error("native workspace selection is foreign or already owned");}
  issued.selected = true;
  return createDarwinAttemptWorkspaceBackend(issued.bridge, retainedOwners);
}

declare const nativeObservationBrand: unique symbol;
export interface DarwinNativeLaunchObservation { readonly [nativeObservationBrand]: true }
export type NativeDirectoryFact = import("../host-custody/darwin-attempt-owner-protocol.ts").DarwinNativeDirectoryData;
type NativeLaunchFacts = import("../host-custody/darwin-attempt-owner-protocol.ts").DarwinNativeLaunchData;
const observations = new WeakMap<DarwinNativeLaunchObservation, Readonly<{ bridge: Bridge; facts: NativeLaunchFacts; generation: number }>>();

export async function readDarwinNativeLaunchObservation(selection: DarwinNativeWorkspaceSelection): Promise<DarwinNativeLaunchObservation> {
  const issued = selections.get(selection);
  if (!issued) {throw new Error("foreign native workspace selection");}
  const captured = await issued.bridge.readLaunchObservation();
  const observation = Object.freeze(Object.create(null)) as DarwinNativeLaunchObservation;
  observations.set(observation, Object.freeze({bridge: issued.bridge, ...captured}));
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
export type NativeFileFact = import("../host-custody/darwin-attempt-owner-protocol.ts").DarwinNativeFileData;
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
