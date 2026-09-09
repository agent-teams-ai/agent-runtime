import { types } from "node:util";
import { fstatSync, lstatSync } from "node:fs";
import {
  createFingerprint, validateSelectedLaunchCandidate, verifyExecutable,
  type ExecutableObservation, type LaunchCandidate, type WorkspaceObservation,
} from "./host-custody-launch.js";
import type { HostCustodyLaunchPlan } from "./custodied-provider-process.js";
import { custodyDataRecord } from "./node-provider-process-custody-http-reservation.js";
import type { HostLaunchFinalizationRecipe } from "./host-custody-finalizable-plan.js";
import { snapshotHostHttpRoute } from "./egress/http-egress-session-authority.js";
import type { HostHttpEgressSessionDependencies } from "./egress/host-http-egress-session.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";
import { assertRetainedWorkspaceAuthority } from "./private-host-custody-reservation.js";
import { finalHostExecutionMaterialSha256 } from "./host-launch-platform-material.js";

const reject = (): never => {throw new TypeError("Host launch finalization identity rejected");};
const sameDirectory = (a: WorkspaceObservation, b: WorkspaceObservation, refresh = false): void => {
  if (a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode ||
      !refresh && a.ctimeNs !== b.ctimeNs) {reject();}
};
const sameExecutable = (a: ExecutableObservation, b: ExecutableObservation): void => {
  if (a.dev !== b.dev || a.ino !== b.ino || a.digest !== b.digest || a.mode !== b.mode ||
      a.nlink !== b.nlink || a.size !== b.size || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs) {reject();}
};

export const validateFinalHostLaunch = async (live: LiveCustody, plan: HostCustodyLaunchPlan, materialSha256: string) => {
  const original = live.launchBinding.reservation;
  const executable = live.executable;
  if (original === undefined || executable === undefined) {return reject();}
  assertRetainedWorkspaceAuthority(live);
  const candidate = await validateSelectedLaunchCandidate(plan, {
    attemptId: live.attemptId, operationId: live.operationId, providerBinding: live.providerBinding,
    workspaceRef: live.workspaceRef, intentMode: original.plan.intentMode,
  }, materialSha256);
  if (candidate.plan.containmentProfile !== original.plan.containmentProfile ||
      candidate.plan.executablePath !== original.plan.executablePath) {return reject();}
  sameDirectory(original.workspace, candidate.workspace);
  sameDirectory(original.privatePaths.root, candidate.privatePaths.root);
  if (original.privatePaths.environmentKeys.join() !== candidate.privatePaths.environmentKeys.join()) {reject();}
  for (const key of original.privatePaths.environmentKeys) {
    const a = original.privatePaths.byEnvironmentKey[key]!;
    const b = candidate.privatePaths.byEnvironmentKey[key]!;
    if (a.path !== b.path) {reject();}
    // Installing the two native files changes directory timestamps, not identity.
    sameDirectory(a, b, key === "CODEX_HOME" || key === "HOME");
  }
  const verifiedExecutable = Object.freeze(await verifyExecutable(plan));
  sameExecutable(executable, verifiedExecutable);
  assertRetainedWorkspaceAuthority(live);
  const executionMaterialSha256 = finalHostExecutionMaterialSha256(candidate, verifiedExecutable, materialSha256, live.httpReservation.darwinRoute?.projection.digest);
  const fingerprint = createFingerprint({attemptId: live.attemptId, operationId: live.operationId,
    providerBinding: live.providerBinding, workspaceRef: live.workspaceRef, intentMode: plan.intentMode},
    plan, live.workspaceRef, plan.arguments, executionMaterialSha256);
  return Object.freeze({...candidate, fingerprint, executable: verifiedExecutable, materialSha256: executionMaterialSha256});
};

/** Synchronous final checks immediately before publication and first execution. */
export const recheckFinalHostLaunch = (live: LiveCustody, launch: LaunchCandidate & {readonly executable: ExecutableObservation}): void => {
  const sealedLinuxRoot = live.launchAuthority !== undefined && launch.plan.containmentProfile === "strict-linux-cgroup-v2";
  if (live.launchAuthority === undefined) {assertRetainedWorkspaceAuthority(live);}
  else {
    live.retainedWorkspaceAuthority!.assertLaunchDescriptor(live.launchAuthority.workspaceDescriptor.parentDescriptor);
    // Host's existing unlinked executable seal changes this directory's ctime.
    // Only the same already-acquired root descriptor may account for that change.
    const root = fstatSync(live.launchAuthority.privateRootDescriptor.parentDescriptor, {bigint: true});
    if (!root.isDirectory()) {reject();}
    sameDirectory(launch.privatePaths.root, root, sealedLinuxRoot);
  }
  for (const [path, observation] of [
    [live.workspaceRef, launch.workspace], [launch.plan.privateRootPath, launch.privatePaths.root],
    ...Object.values(launch.privatePaths.byEnvironmentKey).map(value => [value.path, value] as const),
  ] as const) {
    const stats = lstatSync(path, {bigint: true});
    if (!stats.isDirectory() || stats.isSymbolicLink()) {reject();}
    sameDirectory(observation, stats, sealedLinuxRoot && path === launch.plan.privateRootPath);
  }
  const stats = lstatSync(launch.plan.executablePath, {bigint: true});
  if (!stats.isFile() || stats.isSymbolicLink()) {reject();}
  sameExecutable(launch.executable, {...stats, digest: launch.executable.digest});
};

/** Presence and fixed PA selection are required before publication. These are
 * retained owner capabilities, not proof of route/deployment qualification.
 */
export const retainFinalizationHttpResources = (
  input: HostHttpEgressSessionDependencies, expected: HostLaunchFinalizationRecipe["providerAccess"],
): HostHttpEgressSessionDependencies => {
  const data = custodyDataRecord(input);
  const snapshot = custodyDataRecord(data.providerAccessSnapshot);
  if (snapshot.availability !== "available" || snapshot.revocation !== "active" ||
      Object.entries(expected).some(([key, value]) => snapshot[key as keyof typeof snapshot] !== value)) {reject();}
  const methods = {
    ids: ["fresh"], providerAccess: ["createRequestDigest", "authorize", "observe"],
    materializer: ["render"], runtimeSecurity: ["requestProvisional", "authorizeFirstApplicationByte"],
    verifier: ["verifyProvisionalDecision", "verifyGrant"], localAuthorityCut: ["read"], journal: ["consume"],
    resolver: ["resolve"], transport: ["beginOpen"], clock: ["now", "within"], evidence: ["digest", "record"],
  } as const;
  const retained: Record<string, unknown> = {...data, providerAccessSnapshot: snapshot};
  for (const [key, names] of Object.entries(methods)) {
    const original = data[key as keyof typeof methods];
    const owner = custodyDataRecord(original);
    const operations: Record<string, unknown> = {...owner};
    for (const name of names) {
      const method = (owner as unknown as Record<string, unknown>)[name];
      if (typeof method !== "function" || types.isProxy(method)) {reject();}
      operations[name] = (...args: unknown[]) => Reflect.apply(method as (...args: unknown[]) => unknown, original, args);
    }
    if (key === "verifier") {operations.signingKey = custodyDataRecord(data.verifier.signingKey);}
    retained[key] = Object.freeze(operations);
  }
  const route = snapshotHostHttpRoute(data.route);
  if (route === undefined) {reject();}
  retained.route = route;
  return Object.freeze(retained) as unknown as HostHttpEgressSessionDependencies;
};
