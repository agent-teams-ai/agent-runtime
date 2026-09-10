import {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  assertDarwinNativeLaunchObservationCurrent,
  assertDarwinNativeSelectionExecutionLease, reserveDarwinNativeExecution,
  cutoffDarwinNativeExecution, settleDarwinNativeExecutionLaunchRoute,
  settleDarwinNativeExecutionPrivateMaterial, disposeDarwinNativeExecution,
  type DarwinNativeExecutionLease,
  type DarwinNativeWorkspaceSelection, type DarwinNativeLaunchObservation,
} from "./darwin-attempt-owner-selection.js";
import type { ContainedTurnKernelWorkspaceOwner } from "./contained-turn-kernel-custody-contracts.js";

declare const nativeAuthorityBrand: unique symbol;
/** Private capability, never a Host-readable descriptor or a START authorization. */
export interface NativeHostCustodyWorkspaceAuthority {
  readonly [nativeAuthorityBrand]: true;
  readonly canonicalPath: string;
  readonly identity: Readonly<{dev: bigint; ino: bigint}>;
}
type Ids = Parameters<ContainedTurnKernelWorkspaceOwner["withLaunchAuthority"]>[0];
interface Retained {
  readonly ids: Ids;
  readonly selection: DarwinNativeWorkspaceSelection;
  readonly observation: DarwinNativeLaunchObservation;
  readonly lease: DarwinNativeExecutionLease;
}
// Keep weak identity tombstones after retirement: a native grant must never
// become descriptor authority when the kernel discriminates again after prepare.
const issued = new WeakMap<object, Retained | undefined>();
const transferred = new WeakSet<object>();
const cleanup = new WeakMap<object, Promise<void>>();
export const isNativeHostCustodyWorkspaceAuthority = (value: object): value is NativeHostCustodyWorkspaceAuthority => issued.has(value);
export const inspectNativeHostCustodyWorkspaceAuthority = (
  authority: NativeHostCustodyWorkspaceAuthority, ids: Readonly<{operationId: string; attemptId: string; workspaceId: string}>,
): Readonly<Retained> => {
  const retained = issued.get(authority);
  if (retained === undefined || retained.ids.operationId !== ids.operationId || retained.ids.attemptId !== ids.attemptId ||
      retained.ids.workspaceId !== ids.workspaceId) {
    throw new TypeError("Native workspace authority provenance or attempt mismatch");
  }
  assertDarwinNativeLaunchObservationCurrent(retained.observation);
  return retained;
};
export const inspectNativeHostCustodyReservationAuthority = (
  authority: NativeHostCustodyWorkspaceAuthority,
  input: Readonly<{operationId: string; attemptId: string; workspaceRef: string}>,
): Readonly<Retained> => {
  const retained = issued.get(authority);
  if (retained === undefined || retained.ids.operationId !== input.operationId ||
      retained.ids.attemptId !== input.attemptId || authority.canonicalPath !== input.workspaceRef) {
    throw new TypeError("Native workspace reservation authority mismatch");
  }
  assertDarwinNativeLaunchObservationCurrent(retained.observation);
  return retained;
};
export const inspectNativeHostCustodyExecutionLease = (authority: NativeHostCustodyWorkspaceAuthority): DarwinNativeExecutionLease => {
  const retained = issued.get(authority);
  if (retained === undefined) {throw new TypeError("Native workspace reservation authority unavailable");}
  assertDarwinNativeSelectionExecutionLease(retained.selection, retained.lease);
  return retained.lease;
};
export const consumeNativeHostCustodyExecutionLease = (
  authority: NativeHostCustodyWorkspaceAuthority, expected: DarwinNativeExecutionLease,
): DarwinNativeExecutionLease => {
  const retained = issued.get(authority);
  if (retained === undefined || retained.lease !== expected || transferred.has(authority)) {
    throw new TypeError("Native workspace execution lease transfer conflicts");
  }
  assertDarwinNativeSelectionExecutionLease(retained.selection, retained.lease);
  transferred.add(authority);
  return retained.lease;
};

/** Trusted composition supplies the namespace-issued selection inside the actual
 * owner's fenced callback. The producer authenticates selection and observation;
 * neither callback identity nor caller-authored directory facts issue authority. */
export const withNativeHostCustodyWorkspaceAuthority = async <Result>(
  selection: DarwinNativeWorkspaceSelection, ids: Ids,
  consume: (authority: NativeHostCustodyWorkspaceAuthority) => Promise<Result>,
): Promise<Result> => {
  const captured = Object.freeze({...ids});
  const observation = await readDarwinNativeLaunchObservation(selection);
  const facts = inspectDarwinNativeLaunchObservation(observation);
  assertDarwinNativeLaunchObservationCurrent(observation);
  if (facts.operationId !== captured.operationId) {throw new TypeError("Native workspace operation mismatch");}
  const authority = Object.freeze({canonicalPath: facts.workspace.path,
    identity: Object.freeze({dev: facts.workspace.dev, ino: facts.workspace.ino})}) as NativeHostCustodyWorkspaceAuthority;
  const lease = reserveDarwinNativeExecution(selection);
  issued.set(authority, Object.freeze({ids: captured, selection, observation, lease}));
  try {return await consume(authority);}
  catch (error) {await retireNativeHostCustodyWorkspaceAuthority(authority); throw error;}
};

/** Failure retirement clears retained authority but preserves its native kind; it cannot issue or revive it. */
export const retireNativeHostCustodyWorkspaceAuthority = async (authority: NativeHostCustodyWorkspaceAuthority): Promise<void> => {
  const pending = cleanup.get(authority);
  if (pending !== undefined) {return pending;}
  const retained = issued.get(authority);
  if (retained === undefined) {return;}
  issued.set(authority, undefined);
  if (transferred.has(authority)) {return;}
  const operation = (async () => {
    await cutoffDarwinNativeExecution(retained.lease);
    await settleDarwinNativeExecutionLaunchRoute(retained.lease);
    await settleDarwinNativeExecutionPrivateMaterial(retained.lease);
    await disposeDarwinNativeExecution(retained.lease);
  })();
  cleanup.set(authority, operation);
  return operation;
};
