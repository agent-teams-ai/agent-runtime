import type {NodeDockerDeploymentRecipeInput, NodeDockerConsumptionRecipe, DockerHttpConsumptionReferences, DockerLinuxPostClaimDependencies} from "@agent-teams/agent-execution/composition";

type Consumption = NodeDockerDeploymentRecipeInput["consumption"];
type Envelope = ReturnType<Consumption["readEnvelope"]>;
type Subject = Pick<Envelope, "tenantId" | "projectId" | "scopeDigest" | "operationId" | "attemptId" |
  "custodyId" | "hostBootId" | "hostInstanceId" | "executionGenerationId">;

/** Bind the operation subject before effects; join only observed references at preparation. */
export const bindLinuxCodexNodeConsumption = (input: Omit<Consumption, "readEnvelope">, subject: Subject): Consumption => {
  const expected = Object.freeze({...subject});
  return Object.freeze({directory: Object.freeze({...input.directory}),
    ...(input.limits === undefined ? {} : {limits: Object.freeze({...input.limits})}),
    readEnvelope(references: Parameters<Consumption["readEnvelope"]>[0]) {
      const captured = Object.freeze({...references});
      const envelope = Object.freeze({...expected, ...captured});
      if ((Object.keys(expected) as Array<keyof Subject>).some(key => envelope[key] !== expected[key])) {
        throw new TypeError("Linux Codex consumption envelope binding mismatch");
      }
      return envelope;
    },
  });
};

/** The app joins the actual RS verifier after key generation and captures the
 * selected consumption method with its original receiver before listener IO. */
export const joinLinuxCodexSignerConsumption = (owner: NodeDockerConsumptionRecipe,
  verifier: Readonly<{signingKey: Readonly<{publicKeyDigest: string}>}>): DockerLinuxPostClaimDependencies["resources"]["consumption"] => {
  const signerIdentity = verifier.signingKey.publicKeyDigest;
  const prepare = owner.prepare.bind(owner);
  return Object.freeze({prepare(references: DockerHttpConsumptionReferences) {
    return prepare(Object.freeze({...references, signerIdentity}));
  }});
};
