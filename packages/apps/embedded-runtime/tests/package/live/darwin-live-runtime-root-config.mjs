import {pathToFileURL} from "node:url";
import {isDeepStrictEqual} from "node:util";

const refused = () => new Error("DARWIN_LIVE_RUNTIME_CONFIG_REFUSED");
const pinned = (activation, role, path) => {
  if (typeof path !== "string" || activation.files?.find(entry => entry.role === role)?.path !== path) {throw refused();}
  return pathToFileURL(path).href;
};

const testSessionProvenance = "operator-owned-private-isolated-official-test-session";

/** Local executable policy for the already isolated official test session. The
 * activation contributes JSON scope only; no callback or captured material is serialized. */
export function createAnyTestAccountApproval(value) {
  const scope = structuredClone(value);
  if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.hasOwn(scope, "approvedAccountId")) {throw refused();}
  scope.testSessionProvenance = testSessionProvenance;
  const expected = Object.freeze(structuredClone(scope));
  return Object.freeze({...scope, async approveCapture(metadata) {
    return metadata?.provenance === testSessionProvenance &&
      typeof metadata.accountId === "string" && metadata.accountId.length > 0 &&
      Number.isSafeInteger(metadata.generation) && metadata.generation > 0 &&
      typeof metadata.captureRef === "string" && metadata.captureRef.length > 0 &&
      isDeepStrictEqual(metadata.scope, expected);
  }});
}

export async function preflightDarwinInfrastructure(activation) {
  const infrastructureUrl = pinned(activation, "darwin-infrastructure", activation.infrastructureModulePath);
  const module = await import(infrastructureUrl);
  if (typeof module.preflightDarwinInfrastructure !== "function") {throw refused();}
  const result = await module.preflightDarwinInfrastructure(activation);
  return Object.freeze({...result});
}

/** Imports only activation-hashed executable closure. Auth capture remains in
 * the accepted PA owner and is transferred directly to its renderer. */
export async function acquireDarwinLiveOwners(activation) {
  const paUrl = pinned(activation, "pa-bootstrap", activation.paRuntimeModulePath);
  const infrastructureUrl = pinned(activation, "darwin-infrastructure", activation.infrastructureModulePath);
  const [{acquireAndPublish}, infrastructureModule, providerAccess, agentExecution] = await Promise.all([
    import(paUrl), import(infrastructureUrl), import("@agent-teams/provider-access/composition"),
    import("@agent-teams/agent-execution/composition"),
  ]);
  if (typeof acquireAndPublish !== "function" || typeof infrastructureModule.acquireDarwinInfrastructureOwners !== "function" ||
      typeof providerAccess.createPostgresCurrentProviderAccess !== "function" ||
      typeof agentExecution.createContainedTurnOperationProviderAccessPort !== "function" ||
      typeof agentExecution.createContainedTurnSecurityAcceptancePort !== "function") {throw refused();}
  const infrastructure = await infrastructureModule.acquireDarwinInfrastructureOwners(activation);
  let pa, current, disposed = false, currentClosed = false, paClosed = false;
  try {
    if (typeof activation.turn?.operationId !== "string" || infrastructure.operationId !== activation.turn.operationId ||
        infrastructure.privateAuth?.operationRef !== activation.turn.operationId) {throw refused();}
    pa = await acquireAndPublish(infrastructure.pool, infrastructure.privateAuth,
      createAnyTestAccountApproval(infrastructure.operatorApproval));
    const {tenantId, projectId, scopeDigest} = pa.binding;
    current = providerAccess.createPostgresCurrentProviderAccess(infrastructure.pool,
      {tenantId, projectId, provider: "codex", scopeDigest});
    const readCurrent = pa.routeSelection.readCurrent.bind(pa.routeSelection);
    const providerAccessOwner = Object.freeze({...current.providerAccess,
      dispatchConsumption: pa.dispatchConsumption, readCurrent});
    const dispatchAuthority = Object.freeze({
      providerAccess: agentExecution.createContainedTurnOperationProviderAccessPort(providerAccessOwner),
      security: Object.freeze({acceptance: agentExecution.createContainedTurnSecurityAcceptancePort(
        infrastructure.acceptance, {policyRevision: infrastructure.policyRevision}),
      profile: Object.freeze({policyRevision: infrastructure.policyRevision})}),
    });
    const cleanup = Object.freeze({...infrastructure.assembly.cleanup,
      readback: () => infrastructure.assembly.cleanup.readback({providerAccess: {
        disposed: currentClosed && paClosed}})});
    return Object.freeze({
      ...infrastructure.assembly,
      cleanup,
      dispatchAuthority,
      pool: infrastructure.pool,
      providerAccess: providerAccessOwner,
      rendering: Object.freeze({createRendering: pa.createRendering.bind(pa)}),
      withCredentialOutputInventory: pa.withCredentialOutputInventory.bind(pa),
      async dispose() {
        if (disposed) {return;}
        disposed = true;
        const failures = [];
        try {await current.dispose(); currentClosed = true;} catch (error) {failures.push(error);}
        try {await pa.dispose(); paClosed = true;} catch (error) {failures.push(error);}
        try {await cleanup.captureBeforePoolClose();} catch (error) {failures.push(error);}
        try {await infrastructure.dispose();} catch (error) {failures.push(error);}
        if (failures.length) {throw new AggregateError(failures, "Darwin live owner cleanup failed");}
      },
    });
  } catch (error) {
    try {await current?.dispose();} finally {try {await pa?.dispose();} finally {await infrastructure.dispose();}}
    throw error;
  }
}
