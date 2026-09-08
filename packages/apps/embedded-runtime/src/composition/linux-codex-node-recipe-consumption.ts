import type {NodeDockerDeploymentRecipeInput} from "@agent-teams/agent-execution/composition";

type Consumption = NodeDockerDeploymentRecipeInput["consumption"];
type Envelope = ReturnType<Consumption["readEnvelope"]>;
type Subject = Pick<Envelope, "tenantId" | "projectId" | "scopeDigest" | "operationId" | "attemptId" |
  "custodyId" | "hostBootId" | "hostInstanceId" | "executionGenerationId">;

/** Bind known operation facts now; read actual launch/listener observations only
 * when the existing HTTP owner prepares consumption, after opening its listener.
 * This adapter does not supply the missing observation owner or derive an actual
 * Docker authority, namespace, cgroup, listener or signer identity from a nonce.
 */
export const bindLinuxCodexNodeConsumption = (input: Consumption, subject: Subject): Consumption => {
  const expected = Object.freeze({...subject});
  const read = input.readEnvelope.bind(input);
  return Object.freeze({directory: Object.freeze({...input.directory}),
    ...(input.limits === undefined ? {} : {limits: Object.freeze({...input.limits})}),
    readEnvelope() {
      const envelope = Object.freeze({...read()});
      if ((Object.keys(expected) as Array<keyof Subject>).some(key => envelope[key] !== expected[key])) {
        throw new TypeError("Linux Codex consumption envelope binding mismatch");
      }
      return envelope;
    },
  });
};
