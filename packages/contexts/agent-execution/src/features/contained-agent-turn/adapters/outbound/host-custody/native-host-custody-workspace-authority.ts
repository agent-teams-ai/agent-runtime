import {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  assertDarwinNativeLaunchObservationCurrent,
  type DarwinNativeWorkspaceSelection, type DarwinNativeLaunchObservation,
} from "../filesystem/darwin-attempt-workspace-backend.js";
import {
  withNodeContainedTurnNativeWorkspaceSelection,
  type NodeContainedTurnWorkspaceOwner,
} from "../filesystem/node-contained-turn-workspace-owner.js";

declare const nativeAuthorityBrand: unique symbol;
/** Private capability, never a Host-readable descriptor or a START authorization. */
export interface NativeHostCustodyWorkspaceAuthority {
  readonly [nativeAuthorityBrand]: true;
  readonly canonicalPath: string;
  readonly identity: Readonly<{dev: bigint; ino: bigint}>;
}
type Ids = Parameters<NodeContainedTurnWorkspaceOwner["withLaunchAuthority"]>[0];
interface Retained {
  readonly ids: Ids;
  readonly selection: DarwinNativeWorkspaceSelection;
  readonly observation: DarwinNativeLaunchObservation;
}
const issued = new WeakMap<object, Retained>();
export const isNativeHostCustodyWorkspaceAuthority = (value: object): value is NativeHostCustodyWorkspaceAuthority => issued.has(value);
export const inspectNativeHostCustodyWorkspaceAuthority = (
  authority: NativeHostCustodyWorkspaceAuthority, ids: Readonly<{operationId: string; attemptId: string}>,
): Readonly<Retained> => {
  const retained = issued.get(authority);
  if (retained === undefined || retained.ids.operationId !== ids.operationId || retained.ids.attemptId !== ids.attemptId) {
    throw new TypeError("Native workspace authority provenance or attempt mismatch");
  }
  assertDarwinNativeLaunchObservationCurrent(retained.observation);
  return retained;
};

/** Issuance exists only inside the real workspace owner's callback. No arbitrary
 * observation registration or caller-authored directory facts can issue custody. */
export const withNativeHostCustodyWorkspaceAuthority = async <Result>(
  owner: NodeContainedTurnWorkspaceOwner, ids: Ids,
  consume: (authority: NativeHostCustodyWorkspaceAuthority) => Promise<Result>,
): Promise<Result> => {
  const captured = Object.freeze({...ids});
  let called = false;
  let closed = false;
  let authority: NativeHostCustodyWorkspaceAuthority | undefined;
  try {
    return await withNodeContainedTurnNativeWorkspaceSelection(owner, captured, async selection => {
      if (called || closed) {throw new TypeError("Native workspace selection callback already consumed");}
      called = true;
      const observation = await readDarwinNativeLaunchObservation(selection);
      if (closed) {throw new TypeError("Native workspace selection callback has expired");}
      const facts = inspectDarwinNativeLaunchObservation(observation);
      assertDarwinNativeLaunchObservationCurrent(observation);
      if (facts.operationId !== captured.operationId) {throw new TypeError("Native workspace operation mismatch");}
      const issuedAuthority = Object.freeze({canonicalPath: facts.workspace.path,
        identity: Object.freeze({dev: facts.workspace.dev, ino: facts.workspace.ino})}) as NativeHostCustodyWorkspaceAuthority;
      authority = issuedAuthority;
      issued.set(issuedAuthority, Object.freeze({ids: captured, selection, observation}));
      try {return await consume(issuedAuthority);}
      catch (error) {issued.delete(issuedAuthority); throw error;}
    });
  } catch (error) {
    if (authority !== undefined) {issued.delete(authority);}
    throw error;
  } finally {closed = true;}
};
