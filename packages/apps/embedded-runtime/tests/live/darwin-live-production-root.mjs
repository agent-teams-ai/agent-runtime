import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {lstat, readFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
export async function loadDarwinLiveActivation() {
  const path = join(import.meta.dirname, "activation.json"), parent = await lstat(import.meta.dirname);
  const stat = await lstat(path), bytes = await readFile(path);
  if (await realpath(path) !== path || stat.uid !== 0 || (stat.mode & 0o777) !== 0o444 ||
      parent.uid !== 0 || (parent.mode & 0o022) || !await immutable(path)) {throw refused();}
  const value = JSON.parse(bytes);
  for (const entry of value.files ?? []) {
    const file = await lstat(entry.path), content = await readFile(entry.path);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== 0 || (file.mode & 0o022) ||
        !await immutable(entry.path) || createHash("sha256").update(content).digest("hex") !== entry.sha256) {throw refused();}
  }
  return Object.freeze(value);
}

const immutable = async path => /(^|,)\s*(uchg|schg)(,|$)/u.test((await promisify(execFile)("/usr/bin/stat", ["-f", "%Sf", path], {env: {PATH: "/usr/bin:/bin"}})).stdout.trim());

const refused = () => new Error("DARWIN_LIVE_PRODUCTION_ROOT_REFUSED");

/** Actual Darwin composition root. The pinned activation module acquires the
 * concrete PA/RS/PG and infrastructure owners; this root retains and joins
 * them to the native workspace, deployment route and one public Host handle. */
export async function createDarwinLiveRuntime(activation) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() === 0 ||
      process.argv[2] !== "--darwin-attempt-owner-bridge" || !activation.runtimeRootModulePath) {throw refused();}
  const [{bindDarwinNativeAttemptAuthority, createDarwinContainedTurnDeployment, createHostCustodiedAgentRuntimeHost}, agentExecution] = await Promise.all([
    import("../../dist/composition.js"), import("@agent-teams/agent-execution/composition"),
  ]);
  const {captureRootDarwinAttemptWorkspace, createNodeContainedTurnArtifacts, createNodeContainedTurnWorkspaceOwner} = agentExecution;
  const factoryModule = await import(pathToFileURL(activation.runtimeRootModulePath).href);
  if (typeof factoryModule.acquireDarwinLiveOwners !== "function") {throw refused();}
  const owned = await factoryModule.acquireDarwinLiveOwners(activation);
  const cleanup = [];
  let host, deployment, sealed = false, disposed = false, reconciled = false;
  try {
    cleanup.push(owned.dispose);
    const native = await captureRootDarwinAttemptWorkspace(owned.nativeConsumers);
    const workspaceOwner = await createNodeContainedTurnWorkspaceOwner({...owned.workspace,
      selectedNativeWorkspace: native.selection});
    cleanup.push(workspaceOwner.dispose);
    const artifacts = await createNodeContainedTurnArtifacts({...owned.artifacts, workspaceOwner});
    cleanup.push(artifacts.dispose);
    if (typeof owned.createPostClaimPreparation !== "function") {throw refused();}
    const preparation = await owned.createPostClaimPreparation(native.selection, native.httpLaunchAuthority);
    deployment = createDarwinContainedTurnDeployment({...owned.deployment, preparation,
      providerAccess: owned.providerAccess, rendering: owned.rendering, pool: owned.pool});
    cleanup.push(deployment.dispose);
    const operationStore = deployment.bindStore(bindDarwinNativeAttemptAuthority(owned.operationStore, native.attemptAuthority));
    const dispatchAuthority = deployment.bindAuthority(owned.dispatchAuthority);
    host = createHostCustodiedAgentRuntimeHost({...owned.host,
      containedTurn: {...owned.host.containedTurn, ...dispatchAuthority, operationStore,
        workspace: workspaceOwner.workspace, artifacts,
        routeEnforcement: deployment.routeEnforcement}});
    const sealAdmission = async () => {if (!sealed) {sealed = true; await owned.sealAdmission?.();}};
    return Object.freeze({
      host,
      ...owned.verification,
      sealAdmission,
      async retainForReconciliation(result) {await sealAdmission(); if (!reconciled) {reconciled = true; await owned.reconciliation.retain(result);}},
      async dispose(result) {
        if (disposed) {return owned.cleanup.readback();}
        disposed = true; await sealAdmission();
        if (result?.uncertainty !== undefined && !reconciled) {reconciled = true; await owned.reconciliation.retain(result);}
        try {await host.dispose();} finally {
          for (const action of cleanup.toReversed()) {try {await action?.();} catch (error) {owned.cleanup.recordFailure(error);}}
        }
        return owned.cleanup.readback();
      },
    });
  } catch (error) {
    sealed = true;
    try {await owned.sealAdmission?.();} catch (cleanupError) {owned.cleanup.recordFailure(cleanupError);}
    for (const action of cleanup.toReversed()) {try {await action?.();} catch (cleanupError) {owned.cleanup.recordFailure(cleanupError);}}
    throw error;
  }
}
