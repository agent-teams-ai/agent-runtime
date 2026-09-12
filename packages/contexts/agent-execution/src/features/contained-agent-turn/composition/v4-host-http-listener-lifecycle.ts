import { createDockerHttpListenerLifecycle } from "../adapters/outbound/host-custody/docker/docker-http-listener-entrypoint.js";
import type { NodeCustodyHttpListenerLifecycle } from "../adapters/outbound/host-custody/node-provider-process-custody.js";

/** Private outer projection: acknowledged reservation facts enter the existing
 * V4 authority without coupling Host resource custody to Docker implementation. */
export const createV4HostHttpListenerLifecycle = (
  input: Parameters<typeof createDockerHttpListenerLifecycle>[0],
): NodeCustodyHttpListenerLifecycle => {
  const lifecycle = createDockerHttpListenerLifecycle(input);
  return Object.freeze({bind(lifetime: Parameters<NodeCustodyHttpListenerLifecycle["bind"]>[0]) {
    const proof = lifetime.committedDispatchProof;
    return lifecycle.bind({tenantId: proof.tenantId, projectId: proof.projectId,
      operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
      hostInstanceId: proof.hostInstanceId, hostBootId: proof.hostBootId, effectId: proof.effectId,
      workspaceId: proof.workspaceId, executionGenerationId: proof.executionGenerationId,
      committedClaimSha256: proof.proofDigest.slice(7), acceptedAuthoritySha256: proof.acceptedAuthorityVectorDigest.slice(7)});
  }});
};
