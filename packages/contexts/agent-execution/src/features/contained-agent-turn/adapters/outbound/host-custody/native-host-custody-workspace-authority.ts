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
const issued = new WeakMap<object, Retained>();
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
  catch (error) {issued.delete(authority); throw error;}
};

/** Failure retirement can remove authority only; it cannot issue or revive it. */
export const retireNativeHostCustodyWorkspaceAuthority = (authority: NativeHostCustodyWorkspaceAuthority): void => {
  issued.delete(authority);
};
