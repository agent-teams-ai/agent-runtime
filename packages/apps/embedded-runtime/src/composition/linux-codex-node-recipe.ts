import {createNodeDockerDeploymentRecipe, createDeferredCodexNativeBrokerFiles, type DeferredCodexNativeBrokerFilesOptions, type NodeDockerDeploymentRecipeInput}
  from "@agent-teams/agent-execution/composition";
import type {LinuxCodexDeploymentInfrastructure} from "./linux-codex-deployment.js";
import {bindLinuxCodexNodeConsumption} from "./linux-codex-node-recipe-consumption.js";

type Recipe = LinuxCodexDeploymentInfrastructure["recipe"];
type Selected = ReturnType<Recipe>;
type Input = Parameters<Recipe>[0];
type Preparation = Selected["preparation"];
type Listener = Parameters<NonNullable<Preparation["resources"]["decorateListener"]>>[0];
type NodeOwner = ReturnType<typeof createNodeDockerDeploymentRecipe>;

export interface LinuxCodexNodeRecipeSelection {
  readonly node: Omit<NodeDockerDeploymentRecipeInput, "consumption" | "routeSubject">;
  readonly create: Omit<Preparation["create"], "privateRootSource" | "workspaceSource">;
  readonly subjectFacts: Preparation["subjectFacts"];
  readonly initOptions: Preparation["initOptions"];
  readonly deadlines: Preparation["deadlines"];
  readonly cleanupMilliseconds: number;
  readonly workspaceBackingTreeOwnership: NonNullable<Preparation["workspaceBackingTreeOwnership"]>;
  readonly consumptionSubject: Readonly<{tenantId: string; projectId: string; executionGenerationId: string}>;
  readonly localCut: Preparation["resources"]["localCut"];
  readonly connection: Selected["connection"];
  /** Private deployment wrapper; constructed before open, retained through cleanup.
   * Subject is the independently constructed committed operation, not readback. */
  readonly decorateListener?: (listener: Listener,
    subject: Parameters<Preparation["openResourceJournal"]>[0]["subject"],
    context: Parameters<NonNullable<Preparation["resources"]["decorateListener"]>>[1]) =>
      Listener;
  readonly consumption: Omit<NodeDockerDeploymentRecipeInput["consumption"], "readEnvelope">;
  /** Native file custody remains a separate deployment owner. */
  readonly nativeFileOptions: Omit<DeferredCodexNativeBrokerFilesOptions, "boundary">;
}

/** Private app recipe for infrastructure.recipe. select supplies approved facts,
 * directory pins and native file custody, never an already-built
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
    if (selected.nativeFileOptions === undefined) {
      throw new TypeError("Linux Codex Node recipe requires native-file installation options");
    }
    const kernel = input.kernel;
    const subjectFacts = Object.freeze({...selected.subjectFacts});
    const expected = Object.freeze({operationId: kernel.operationId, attemptId: kernel.attemptId,
      custodyId: kernel.custodyId, hostBootId, hostInstanceId,
      tenantId: selected.consumptionSubject.tenantId, projectId: selected.consumptionSubject.projectId,
      executionGenerationId: selected.consumptionSubject.executionGenerationId});
    const node = createNodeDockerDeploymentRecipe({...selected.node,
      routeSubject: {operationId: kernel.operationId, attemptId: kernel.attemptId, custodyId: kernel.custodyId,
        executionGenerationId: expected.executionGenerationId, authorityVectorDigest: kernel.authorityVectorDigest, hostBootId},
      consumption: bindLinuxCodexNodeConsumption(selected.consumption, {...expected, scopeDigest: `sha256:${subjectFacts.scopeSha256}`})});
    retained.set(kernel.custodyId, node);
    const nativeFiles = createDeferredCodexNativeBrokerFiles({...selected.nativeFileOptions, boundary: input.record.boundary});
    const init = selected.initOptions;
    let resourceSubject: Parameters<Preparation["openResourceJournal"]>[0]["subject"] | undefined;
    const decorate = selected.decorateListener?.bind(selected);
    const preparation: Preparation = Object.freeze({...node.preparation,
      workspaceBackingTreeOwnership: Object.freeze({...selected.workspaceBackingTreeOwnership}),
      openResourceJournal(request: Parameters<Preparation["openResourceJournal"]>[0]) {
        const actual = {...request.subject.attempt, executionGenerationId: request.subject.executionGenerationId};
        if ((Object.keys(expected) as Array<keyof typeof expected>).some(key => actual[key] !== expected[key]) ||
            request.subject.scopeSha256 !== subjectFacts.scopeSha256) {
          throw new TypeError("Linux Codex consumption subject conflicts with claimed handoff");
        }
        if (decorate !== undefined) {resourceSubject = structuredClone(request.subject);}
        return node.preparation.openResourceJournal(request);
      },
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
      resources: Object.freeze({...(decorate === undefined ? {} : {decorateListener(listener: Listener, context: Parameters<NonNullable<Preparation["resources"]["decorateListener"]>>[1]) {
        if (resourceSubject === undefined) {throw new TypeError("Operation resource subject unavailable");}
        return decorate(listener, resourceSubject, context);
      }}), localCut: Object.freeze({...selected.localCut,
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
