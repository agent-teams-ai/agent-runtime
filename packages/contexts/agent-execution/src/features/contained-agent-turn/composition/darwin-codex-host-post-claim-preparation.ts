import {isDarwinCodexEffectCustodyOwner, type DarwinCodexEffectCustodyOwner} from "./darwin-codex-effect-custody-owner.js";
import { createDarwinNativeCodexPermissionBoundary, codexDarwinNativeLaunchObservation,
  type CodexAppServerPermissionBoundary, type CodexContainedTurnMode } from "../adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";

/** Before PG prepare: authenticate the native original roots without consuming
 * the kernel's later workspace selection callback or inventing an attempt. */
export const prepareDarwinCodexNativeLaunchInput = async (
  selection: DarwinNativeWorkspaceSelection, intentMode: CodexContainedTurnMode,
  httpLaunchAuthority?: RetainedNativeHttpLaunchAuthority,
) => {
  const observation = await readDarwinNativeLaunchObservation(selection);
  const boundary = createDarwinNativeCodexPermissionBoundary(observation, intentMode);
  const facts = inspectDarwinNativeLaunchObservation(observation);
  return Object.freeze({boundary, httpLaunchAuthority,
    privateRootPath: facts.privateRoot.path, tmpDir: facts.tmpDir.path});
};

/** Assembly calls this after the real committed-claim/session owner, before its
 * synchronous finalizer. The native producer independently gates installation
 * on its genuine bound claim. This does not manufacture resource receipts. */
export const prepareDarwinCodexNativeFixedMaterial = async (
  selection: DarwinNativeWorkspaceSelection, recipe: CodexNativeBrokerRecipe, catalogSource: Uint8Array,
) => Object.freeze({recipe, files: await installCodexDarwinNativeBrokerFiles(selection, recipe, catalogSource)});

import {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  type DarwinNativeWorkspaceSelection,
  type RetainedNativeHttpLaunchAuthority, type DarwinNativeExecutionLease,
  hostHttpAbortOperations,
  type ContainedTurnHostPostClaimPreparation,
  NodeProviderProcessCustodyCore,
  DarwinRouteDurableStorage, darwinDigest, type DarwinTrustedDirectory,
  DarwinRouteLifecycleJournal,
  DarwinSeatbeltRouteOwner,
  pinDarwinExecutable, createDarwinSeatbeltProjection,
  createDarwinHostHttpConsumptionJournal,
  createNodeHostHttpListener,
  createNodeHostHttpConnection,
  retainFinalizationHttpResources,
  type HostHttpEgressSessionDependencies,
  type HostHttpLocalCutInput,
  type HttpEgressLimits,
} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {
  installCodexDarwinNativeBrokerFiles, readCodexDarwinNativeMaterial, type CodexNativeBrokerRecipe,
  DarwinCodexNativeFiles, codexNativeBrokerLaunchInput,
  createDarwinCodexNativeBrokerRecipe, prepareCodexNativeBrokerFiles, codexDarwinNativeMaterialIdentity,
} from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

export interface DarwinCodexHostPreparationInput {
  readonly hostCustody: unknown;
  readonly effectCustody?: DarwinCodexEffectCustodyOwner;
  /** Stable coordinator-selected namespace, outside every provider-writable root.
   * Must be the original locator namespace on restart, never a fresh retry tree. */
  readonly durableRoot: DarwinTrustedDirectory;
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly httpLaunchAuthority?: RetainedNativeHttpLaunchAuthority;
  readonly executable: Readonly<{path: string; sha256: string}>;
  readonly observer: Readonly<{path: string; sha256: string}>;
  readonly launcherSha256: string;
  readonly nodeSha256: string;
  readonly catalogSource: Uint8Array;
  readonly tmpDir: string;
  readonly localCut: Omit<HostHttpLocalCutInput, "claimed" | "identity">;
  readonly limits: HttpEgressLimits;
  /** Existing genuine PA/RS/resolver/transport/evidence owners. The actual
   * reservation replaces identity, consumption, route and local clock slots. */
  readonly session: HostHttpEgressSessionDependencies;
}

const snapshotPreparationInput = (input: DarwinCodexHostPreparationInput) => {
  return Object.freeze({...input, executable: Object.freeze({...input.executable}),
    observer: Object.freeze({...input.observer}), durableRoot: Object.freeze({...input.durableRoot}),
    catalogSource: Buffer.from(input.catalogSource), limits: Object.freeze({...input.limits}),
    localCut: Object.freeze({...input.localCut, expectedClock: Object.freeze({...input.localCut.expectedClock}),
      clock: Object.freeze({read: input.localCut.clock.read.bind(input.localCut.clock), within: input.localCut.clock.within.bind(input.localCut.clock)})})});
};

const hasRequiredNativeOwners = (options: DarwinCodexHostPreparationInput): boolean => {
  // Native execution requires matching retained HTTP and effect owners before allocation.
  const observation = codexDarwinNativeLaunchObservation(options.boundary);
  const native = options.httpLaunchAuthority;
  return (observation === undefined) === (native === undefined) &&
    (native === undefined || isDarwinCodexEffectCustodyOwner(options.effectCustody));
};

/** One-operation candidate factory for createCodexCurrentKernelOwner's existing
 * postClaimPreparation option. No public export, product qualification bypass,
 * Linux storage selection, arbitrary native callback or detached route owner. */
export const createDarwinCodexHostPostClaimPreparation = (input: DarwinCodexHostPreparationInput): ContainedTurnHostPostClaimPreparation => {
  const options = snapshotPreparationInput(input);
  let entered = false;
  return Object.freeze({prepareClaimed: async (claimed: Parameters<ContainedTurnHostPostClaimPreparation["prepareClaimed"]>[0]) => {
    if (entered) {return Object.freeze({kind: "quarantined" as const});} entered = true;
    let route: DarwinSeatbeltRouteOwner | undefined;
    let routeShutdownSubscription: ReturnType<typeof hostHttpAbortOperations.subscribe> | undefined;
    const settleAbortSubscriptions = () => {
      if (routeShutdownSubscription !== undefined) {
        hostHttpAbortOperations.remove(routeShutdownSubscription); routeShutdownSubscription = undefined;
      }
      if (isDarwinCodexEffectCustodyOwner(options.effectCustody)) {options.effectCustody.dispose();}
    };
    let nativeLease: DarwinNativeExecutionLease | undefined;
    try {
      const native = options.httpLaunchAuthority;
      if (!hasRequiredNativeOwners(options)) {
        return Object.freeze({kind: "unsupported" as const, reason: "owner" as const});
      }
      const preparation = NodeProviderProcessCustodyCore.httpPreparation(options.hostCustody);
      if (preparation === undefined || process.platform !== "darwin" || claimed.signal.aborted ||
          options.limits.deadline !== options.localCut.operationDeadline || options.limits.closureDeadline <= options.limits.deadline) {
        return Object.freeze({kind: "unsupported" as const, reason: "owner" as const});
      }
      // Exact compiled observer/artifact inputs are mandatory BEFORE allocation.
      const observer = pinDarwinExecutable(options.observer.path, options.observer.sha256);
      const launcher = pinDarwinExecutable("/usr/bin/sandbox-exec", options.launcherSha256);
      const provider = pinDarwinExecutable(options.executable.path, options.executable.sha256);
      const node = pinDarwinExecutable(process.execPath, options.nodeSha256);
      const sessionInput = retainFinalizationHttpResources(options.session, options.session.providerAccessSnapshot);
      const proof = claimed.committedDispatchProof;
      if (proof.provider !== "codex" || sessionInput.route.requestProfile !== "codex-chatgpt-responses/v1" ||
          sessionInput.providerAccessSnapshot.tenantId !== proof.tenantId ||
          sessionInput.providerAccessSnapshot.projectId !== proof.projectId) {throw new TypeError("Darwin broker selection conflicts");}
      const lifetime = preparation.acquire(claimed);
      if (native !== undefined) {
        nativeLease = preparation.consumeDarwinNativeExecution(lifetime, native);
        options.effectCustody!.bind(nativeLease, proof, {operationId: proof.operationId, attemptId: proof.attemptId,
          custodyRef: proof.custodyId, effectId: proof.effectId, workspaceRef: options.boundary.workspaceRef});
        options.effectCustody!.observeAbort(claimed.signal);
        if (options.localCut.hostShutdownSignal !== undefined) {
          options.effectCustody!.observeAbort(options.localCut.hostShutdownSignal);
        }
        if (claimed.signal.aborted) {options.effectCustody!.cutoff(); throw new Error("Darwin effect custody claim aborted");}
      }
      const locator = darwinDigest(JSON.stringify(["darwin-operation-locator/v1", proof.tenantId, proof.projectId, proof.operationId]));
      const storage = new DarwinRouteDurableStorage(options.durableRoot, locator);
      const journal = new DarwinRouteLifecycleJournal(storage, lifetime);
      let files: DarwinCodexNativeFiles | undefined;
      route = new DarwinSeatbeltRouteOwner(lifetime, journal, options.localCut, options.limits.closureDeadline,
        {node, nativeLaunch: codexNativeBrokerLaunchInput,
          files: async () => {
            settleAbortSubscriptions();
            return nativeLease === undefined ? files?.cleanup() ?? true : true;
          }});
      const owner = route;
      if (nativeLease === undefined) {
        files = new DarwinCodexNativeFiles(options.boundary, options.catalogSource, journal, () => owner.assertActive());
      }
      preparation.retainDarwinRoute(lifetime, owner);
      owner.assertWritableTmp(options.tmpDir);
      if (options.localCut.hostShutdownSignal !== undefined) {
        routeShutdownSubscription = hostHttpAbortOperations.subscribe(options.localCut.hostShutdownSignal, () => owner.cutoff());
      }
      return await owner.run(async () => {
        await journal.prepare(); owner.assertActive();
        let lastTime = -1;
        // Borrow the clock before session binding; closure must still read it
        // after route cutoff. Never borrow an unbound local-cut owner's clock.
        const clock = Object.freeze({now: () => {
          const sample = options.localCut.clock.read();
          if (sample.authorityId !== options.localCut.expectedClock.authorityId || sample.epoch !== options.localCut.expectedClock.epoch ||
              !Number.isSafeInteger(sample.controlTime) || sample.controlTime < lastTime || sample.controlTime < 0) {
            owner.cutoff(); throw new TypeError("Darwin Host clock drift");
          }
          lastTime = sample.controlTime; return lastTime;
        }, within: options.localCut.clock.within.bind(options.localCut.clock)});
        const listener = createNodeHostHttpListener({host: "127.0.0.1", deadline: options.limits.deadline,
          closureDeadline: options.limits.closureDeadline}, clock);
        let address: Awaited<ReturnType<typeof listener.open>>["address"] | undefined;
        let session: ReturnType<ReturnType<typeof preparation.finalize>["bindSession"]> | undefined;
        let requestCount = 0;
        const consumption = Object.freeze({prepare: async () => {
          if (address === undefined) {throw new TypeError("Darwin listener not bound");}
          return createDarwinHostHttpConsumptionJournal(storage, {tenantId: proof.tenantId, projectId: proof.projectId,
            operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
            hostBootId: proof.hostBootId, generation: proof.executionGenerationId,
            authorityVectorDigest: proof.acceptedAuthorityVectorDigest, listenerIdentity: darwinDigest(JSON.stringify(address))}).prepare();
        }});
        const wrapped = journal.wrapListener(listener);
        const resources = await preparation.prepareResources(lifetime, {
          listenerLifecycle: journal.listenerLifecycle, localCut: options.localCut, consumption,
          listener: Object.freeze({...wrapped, open: async (...args: Parameters<typeof wrapped.open>) => {
            const opened = await wrapped.open(...args); address = opened.address; return opened;
          }}),
          accept: async (socket, signal) => {
            let connection: ReturnType<ReturnType<typeof createNodeHostHttpConnection>["bindAcceptedSocket"]> | undefined;
            const controller = new AbortController(); const abort = () => controller.abort();
            const subscription = hostHttpAbortOperations.subscribe(signal, abort);
            try {
              // Even TLS/resolver work is refused before installed admission.
              owner.assertInstalled();
              if (session === undefined || address === undefined || ++requestCount > 256) {throw new Error("Darwin broker unavailable");}
              const expectedRequest = {requestId: `darwin-request-${requestCount}`, method: "POST",
                path: "/backend-api/codex/responses", host: `127.0.0.1:${address.port}`};
              connection = createNodeHostHttpConnection({expectedRequest, limits: options.limits}, clock).bindAcceptedSocket(socket, controller);
              const receipt = await session.execute({operationId: proof.operationId, attemptId: proof.attemptId,
                expectedRequest, limits: options.limits, connection: connection.connection, signal: connection.signal});
              if (receipt.outcome !== "completed") {owner.cutoff();}
            } catch {
              owner.cutoff(); controller.abort();
              if (connection !== undefined) {await connection.connection.close("abort");} else {socket.destroy();}
            } finally {subscription[Symbol.dispose]();}
          },
        });
        owner.assertActive(); if (resources.kind !== "prepared" || resources.address.address !== "127.0.0.1") {throw new Error("Darwin HTTP preparation unproven");}
        const recipe = createDarwinCodexNativeBrokerRecipe({boundary: options.boundary,
          endpoint: `http://127.0.0.1:${resources.address.port}/backend-api/codex`, profile: "codex-chatgpt", tmpDir: options.tmpDir});
        owner.assertWritableTmp(options.tmpDir);
        if (nativeLease !== undefined) {await installCodexDarwinNativeBrokerFiles(nativeLease, recipe, options.catalogSource);}
        else {files!.install(recipe);}
        owner.assertActive();
        const installation = nativeLease === undefined
          ? files!.installationMaterial()
          : codexDarwinNativeMaterialIdentity(recipe);
        if (installation === undefined) {throw new Error("Darwin native installation material unavailable");}
        const projection = createDarwinSeatbeltProjection({launcher, observer, provider,
          endpoint: {...resources.address, address: "127.0.0.1"}, operationBinding: {proof: proof.proofDigest,
            generation: lifetime.hostLifecycleGenerationSha256, installation},
          protectedRoot: options.durableRoot.path,
          readPaths: ["/System/Library", "/usr/lib", options.boundary.workspaceRef, options.boundary.codexHome],
          writePaths: [options.tmpDir], installationPath: `${options.boundary.codexHome}/installation_id`});
        owner.authorize(projection);
        const preparedFiles = await prepareCodexNativeBrokerFiles(recipe); owner.assertActive();
        const finalizer = preparation.finalize(lifetime);
        const staged = await finalizer.stage({recipe, files: preparedFiles}); owner.assertActive();
        session = finalizer.bindSession({...sessionInput, journal: resources.journal, routeFirstWrite: owner.firstWrite,
          identity: {operationId: proof.operationId, attemptId: proof.attemptId, custodyId: proof.custodyId,
            hostBootId: proof.hostBootId, liveProcessSessionIdentity: lifetime.executionSessionIdentity}});
        owner.assertActive(); const launch = finalizer.commit(staged); owner.assertActive();
        if (nativeLease !== undefined) {
          await preparation.bindDarwinNativeFinalLaunch(lifetime, native!, nativeLease,
            readCodexDarwinNativeMaterial(recipe), resources.address.port, launch);
          owner.assertActive();
        }
        return Object.freeze({kind: "prepared" as const});
      });
    } catch {
      settleAbortSubscriptions();
      route?.cutoff();
      // Once transferred, the Host HTTP reservation is the sole terminal owner.
      // Containment/release preserves and retries each native cleanup phase.
      return Object.freeze({kind: "quarantined" as const});
    }
  }});
};
