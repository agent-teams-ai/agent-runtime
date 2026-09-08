import {createNodeDockerDeploymentRecipe, type NodeDockerDeploymentRecipeInput}
  from "@agent-teams/agent-execution/composition";
import type {LinuxCodexDeploymentInfrastructure} from "./linux-codex-deployment.js";
import {bindLinuxCodexNodeConsumption} from "./linux-codex-node-recipe-consumption.js";

type Recipe = LinuxCodexDeploymentInfrastructure["recipe"];
type Selected = ReturnType<Recipe>;
type Input = Parameters<Recipe>[0];
type Preparation = Selected["preparation"];
type NodeOwner = ReturnType<typeof createNodeDockerDeploymentRecipe>;

export interface LinuxCodexNodeRecipeSelection {
  readonly node: Omit<NodeDockerDeploymentRecipeInput, "consumption">;
  readonly create: Omit<Preparation["create"], "privateRootSource" | "workspaceSource">;
  readonly subjectFacts: Preparation["subjectFacts"];
  readonly initOptions: Preparation["initOptions"];
  readonly deadlines: Preparation["deadlines"];
  readonly cleanupMilliseconds: number;
  readonly consumptionSubject: Readonly<{tenantId: string; projectId: string; executionGenerationId: string}>;
  readonly localCut: Preparation["resources"]["localCut"];
  readonly connection: Selected["connection"];
  /** Missing production joins at c57e746: the native renderer has a verifier but
   * no installer retaining partial-file debt; consumption storage has no owner
   * joining the actual launched Docker/listener identities into its envelope.
   * Absence refuses selection before any Engine/filesystem effect. These are
   * exact existing contracts, never qualified by a callback's mere presence. */
  readonly remainingOwners?: Readonly<{
    nativeFiles: Selected["nativeFiles"];
    consumption: NodeDockerDeploymentRecipeInput["consumption"];
  }>;
}

/** Private app recipe for infrastructure.recipe. select supplies approved facts,
 * directory pins and the two still-missing owner joins, never an already-built
 * recipe. The AE factory constructs Engine identity, concrete Linux lifecycle,
 * V4/consumption journals and route inspection. The existing Host constructs
 * private-root custody, operation network, listener, route lease and finalizer.
 */
export const createLinuxCodexNodeRecipe = (options: Readonly<{
  hostBootId: string;
  hostInstanceId: string;
  select(input: Input): LinuxCodexNodeRecipeSelection;
}>): Readonly<{recipe: Recipe; releaseAfterHostCleanup(call: Parameters<NodeOwner["releaseAfterHostCleanup"]>[0]): Promise<"released" | "pending">}> => {
  const select = options.select.bind(options);
  const hostBootId = options.hostBootId;
  const hostInstanceId = options.hostInstanceId;
  const retained = new Map<string, NodeOwner | undefined>();
  let closed = false;
  const recipe: Recipe = input => {
    if (closed || retained.has(input.kernel.custodyId) || retained.size >= 64) {
      throw new TypeError("Linux Codex Node recipe reservation unavailable");
    }
    retained.set(input.kernel.custodyId, undefined);
    const selected = select(input);
    if (closed) {throw new TypeError("Linux Codex Node recipe admission closed during selection");}
    const owners = selected.remainingOwners;
    if (typeof owners?.nativeFiles?.install !== "function" || typeof owners.consumption?.readEnvelope !== "function") {
      throw new TypeError("Linux Codex Node recipe requires native-file installation and observed consumption-envelope owners");
    }
    const kernel = input.kernel;
    const subjectFacts = Object.freeze({...selected.subjectFacts});
    const expected = Object.freeze({operationId: kernel.operationId, attemptId: kernel.attemptId,
      custodyId: kernel.custodyId, hostBootId, hostInstanceId,
      tenantId: selected.consumptionSubject.tenantId, projectId: selected.consumptionSubject.projectId,
      executionGenerationId: selected.consumptionSubject.executionGenerationId});
    const node = createNodeDockerDeploymentRecipe({...selected.node,
      consumption: bindLinuxCodexNodeConsumption(owners.consumption, {...expected, scopeDigest: `sha256:${subjectFacts.scopeSha256}`})});
    retained.set(kernel.custodyId, node);
    const nativeFiles = Object.freeze({install: owners.nativeFiles.install.bind(owners.nativeFiles)});
    const init = selected.initOptions;
    const preparation: Preparation = Object.freeze({...node.preparation,
      create: Object.freeze({entrypoint: selected.create.entrypoint, imageDigest: selected.create.imageDigest,
        launchFingerprintSha256: selected.create.launchFingerprintSha256,
        operationNonceSha256: selected.create.operationNonceSha256, workspaceWritable: selected.create.workspaceWritable,
        arguments: Object.freeze([...selected.create.arguments]),
        environment: Object.freeze({...selected.create.environment}),
        privateRootSource: input.record.privateRootPath, workspaceSource: input.record.boundary.workspaceRef}),
      subjectFacts, initOptions: Object.freeze({...init,
        authority: Object.freeze({...init.authority, expectedIdentity: Object.freeze({...init.authority.expectedIdentity})}),
        isCurrentGeneration: init.isCurrentGeneration.bind(init),
        ...(init.isObservationActive === undefined ? {} : {isObservationActive: init.isObservationActive.bind(init)}),
        ...(init.monotonicNow === undefined ? {} : {monotonicNow: init.monotonicNow.bind(init)}),
        ...(init.onOutput === undefined ? {} : {onOutput: init.onOutput.bind(init)}),
        ...(init.onRootExit === undefined ? {} : {onRootExit: init.onRootExit.bind(init)}),
        ...(init.onDrainComplete === undefined ? {} : {onDrainComplete: init.onDrainComplete.bind(init)})}),
      deadlines: Object.freeze({...selected.deadlines}), cleanupMilliseconds: selected.cleanupMilliseconds,
      // The real private-root capture replaces this slot before launch. It is
      // deliberately invalid as a generation observation on its own.
      hostLifecycleGenerationSha256: "",
      resources: Object.freeze({localCut: Object.freeze({...selected.localCut,
        expectedClock: Object.freeze({...selected.localCut.expectedClock}),
        clock: Object.freeze({read: selected.localCut.clock.read.bind(selected.localCut.clock),
          within: selected.localCut.clock.within.bind(selected.localCut.clock)})}), consumption: node.consumption}),
    });
    return Object.freeze({preparation, route: node.route, nativeFiles,
      connection: Object.freeze({...selected.connection, limits: Object.freeze({...selected.connection.limits})}),
      hostSession: Object.freeze({
        // Unbound marker only. The Host replaces this entire identity before
        // authenticating ingress; neither placeholder can authorize a write.
        identity: Object.freeze({operationId: expected.operationId, attemptId: expected.attemptId,
          custodyId: expected.custodyId, hostBootId: expected.hostBootId, liveProcessSessionIdentity: Object.freeze({})}),
        localAuthorityCut: Object.freeze({read(): never {throw new TypeError("Host session has not been activated");}}),
        journal: Object.freeze({consume: () => "unknown" as const}),
      }),
    });
  };
  return Object.freeze({recipe,
    /** Root retains this companion to infrastructure.recipe and invokes it only
     * after Host cleanup. pending preserves every owner for a subsequent retry;
     * it is not an operation result or a physical-containment assertion. */
    async releaseAfterHostCleanup(call: Parameters<NodeOwner["releaseAfterHostCleanup"]>[0]) {
      closed = true;
      let result: "released" | "pending" = "released";
      for (const owner of retained.values()) {
        if (owner !== undefined && await owner.releaseAfterHostCleanup(call) !== "released") {result = "pending";}
      }
      return result;
    },
  });
};
