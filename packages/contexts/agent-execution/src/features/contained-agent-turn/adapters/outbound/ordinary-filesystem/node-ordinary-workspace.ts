import {mkdir, mkdtemp, rm, lstat} from "node:fs/promises";
import {join, relative} from "node:path";
import type {OrdinaryWorkspacePort, OrdinaryWorkspaceHandle} from "../../../application/ordinary-ports.js";
import type {OrdinaryOperation} from "../../../domain/ordinary-model.js";
import {directory, inventory, digest, writeSynced, type Inventory} from "./ordinary-files.js";

const outside = (parent: string, child: string): boolean => {const path = relative(parent, child); return path === ".." || path.startsWith("../");};
const identity = async (path: string): Promise<string> => { const s = await lstat(path); return `${s.dev}:${s.ino}`; };
export interface OrdinaryWorkspaceObservation {readonly kind: "workspace_allocated" | "workspace_prepared" | "workspace_retained" | "workspace_closed"; readonly operationId: string; readonly attemptId: string; readonly workspaceId: string; readonly root: string; readonly rootIdentity: string | null}
export interface NodeOrdinaryWorkspaceOptions {readonly sourceDirectory: string; readonly workspaceRoot: string; readonly sourceRevision: string; readonly record?: (observation: OrdinaryWorkspaceObservation) => void}
export class OrdinaryWorkspacePreparationRetained extends Error {
  constructor(readonly retainedRoot: string, readonly workspaceId: string, options: ErrorOptions) {super("ordinary_workspace_preparation_retained", options);}
}
export function createNodeOrdinaryWorkspace(options: NodeOrdinaryWorkspaceOptions): OrdinaryWorkspacePort {
  const owned = new Map<string, {handle: OrdinaryWorkspaceHandle; operation: OrdinaryOperation; source: Inventory; root: string; rootIdentity: string; cwdIdentity: string; uncertain: boolean}>();
  return {
    async prepare(operation, signal) {
      signal.throwIfAborted();
      await directory(options.sourceDirectory, true); await directory(options.workspaceRoot, true);
      if (!options.sourceRevision || !outside(options.sourceDirectory, options.workspaceRoot) || !outside(options.workspaceRoot, options.sourceDirectory)) {throw new Error("ordinary_source_workspace_overlap");}
      const source = await inventory(options.sourceDirectory);
      if (source.directories.includes("TASK.md")) {throw new Error("ordinary_task_path_is_directory");}
      const root = await mkdtemp(join(options.workspaceRoot, "ordinary-"));
      const cwd = join(root, "workspace"), homeDirectory = join(root, "home");
      const workspaceId = digest(root);
      const handle = Object.freeze({workspaceId, cwd, homeDirectory});
      const state = {handle, operation, source, root, rootIdentity: "", cwdIdentity: "", uncertain: true}; owned.set(workspaceId, state);
      const record = (kind: OrdinaryWorkspaceObservation["kind"]): void => {
        const result: unknown = options.record?.({kind, operationId: operation.operationId, attemptId: operation.attemptId, workspaceId, root, rootIdentity: state.rootIdentity || null});
        if (result !== undefined) {if (result instanceof Promise) {void result.catch(() => {});} throw new Error("ordinary_workspace_evidence_not_synchronous");}
      };
      try {
      state.rootIdentity = await identity(root);
      record("workspace_allocated");
      await mkdir(cwd, {mode: 0o700}); await mkdir(homeDirectory, {mode: 0o700});
      state.cwdIdentity = await identity(cwd);
      for (const dir of source.directories) {await mkdir(join(cwd, dir), {mode: 0o700});}
      for (const [path, bytes] of source.files) {
        await writeSynced(join(cwd, path), bytes);
      }
      if (!source.files.has("TASK.md")) {await writeSynced(join(cwd, "TASK.md"), operation.input.intent.prompt);}
      if ((await inventory(options.sourceDirectory)).metadataDigest !== source.metadataDigest) {throw new Error("ordinary_source_mutated");}
      signal.throwIfAborted(); record("workspace_prepared"); state.uncertain = false;
      return handle;
      } catch (error) {
        try {record("workspace_retained");} catch { /* The allocated root remains recoverable from the typed error if the evidence sink also fails. */ }
        throw new OrdinaryWorkspacePreparationRetained(root, workspaceId, {cause: error});
      }
    },
    async snapshot(operation, handle) {
      const state = owned.get(handle.workspaceId);
      if (!state || state.handle !== handle || state.operation.operationId !== operation.operationId || state.operation.attemptId !== operation.attemptId) {throw new Error("ordinary_workspace_binding");}
      state.uncertain = true;
      await directory(state.root, true);
      if (await identity(state.root) !== state.rootIdentity || await identity(handle.cwd) !== state.cwdIdentity) {throw new Error("ordinary_workspace_replaced");} await directory(handle.cwd, true);
      const before = await inventory(handle.cwd);
      const result = before.files.get("result.txt");
      if (!result) {throw new Error("ordinary_result_missing");}
      if ((await inventory(handle.cwd)).metadataDigest !== before.metadataDigest) {throw new Error("ordinary_workspace_mutated");}
      if ((await inventory(options.sourceDirectory)).metadataDigest !== state.source.metadataDigest) {throw new Error("ordinary_source_mutated");}
      const resultBytes = Uint8Array.from(result);
      state.uncertain = false;
      return {resultBytes, receipt: {operationId: operation.operationId, attemptId: operation.attemptId, executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision, kind: "workspace_snapshot", workspaceId: handle.workspaceId, snapshotDigest: digest(resultBytes), sourceDigest: state.source.contentDigest, inventoryDigest: before.contentDigest, stable: true}};
    },
    async close(handle) {
      const state = owned.get(handle.workspaceId);
      if (!state || state.handle !== handle) {throw new Error("ordinary_workspace_not_owned");}
      if (state.uncertain) {throw new Error("ordinary_workspace_retained_for_reconciliation");}
      await directory(state.root, true);
      if (await identity(state.root) !== state.rootIdentity || await identity(handle.cwd) !== state.cwdIdentity) {throw new Error("ordinary_workspace_replaced");}
      await rm(state.root, {recursive: true});
      const absent = await lstat(state.root).then(() => false, error => {if (error.code === "ENOENT") {return true;} throw error;});
      if (!absent) {throw new Error("ordinary_workspace_cleanup_unconfirmed");}
      const recorded: unknown = options.record?.({kind: "workspace_closed", operationId: state.operation.operationId, attemptId: state.operation.attemptId, workspaceId: handle.workspaceId, root: state.root, rootIdentity: state.rootIdentity});
      if (recorded !== undefined) {if (recorded instanceof Promise) {void recorded.catch(() => {});} throw new Error("ordinary_workspace_evidence_not_synchronous");}
      owned.delete(handle.workspaceId);
    },
  };
}
