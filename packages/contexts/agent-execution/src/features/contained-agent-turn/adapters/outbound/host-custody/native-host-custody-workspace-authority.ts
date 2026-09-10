import {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  assertDarwinNativeLaunchObservationCurrent,
  type DarwinNativeWorkspaceSelection, type DarwinNativeLaunchObservation,
} from "./contained-turn-kernel-custody-entrypoint.js";
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
}
// Keep weak identity tombstones after retirement: a native grant must never
// become descriptor authority when the kernel discriminates again after prepare.
const issued = new WeakMap<object, Retained | undefined>();
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
  issued.set(authority, Object.freeze({ids: captured, selection, observation}));
  try {return await consume(authority);}
  catch (error) {issued.set(authority, undefined); throw error;}
};

/** Failure retirement clears retained authority but preserves its native kind; it cannot issue or revive it. */
export const retireNativeHostCustodyWorkspaceAuthority = (authority: NativeHostCustodyWorkspaceAuthority): void => {
  if (issued.has(authority)) {issued.set(authority, undefined);}
};
