import {createCodexDockerPathProjection, codexDockerProjectionSource, projectCodexDockerExecutable,
  projectCodexDockerPrivatePath, type CodexDockerPathProjection,
  CodexAppServerCurrentKernelAdapter, type CodexAppServerKernelAttemptFactory}
  from "../adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import type {ContainedTurnKernelProviderPort} from "../application/ports/outbound/contained-turn-ports.js";
import {digestContainedTurnCanonicalValue} from "../domain/contained-turn-codecs.js";
import {CodexAppServerContainedTurnProvider}
  from "../adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import {codexNativeBrokerDockerPaths, snapshotCodexDataRecord, isIssuedCodexAppServerLaunchPlan, isCodexNativeBrokerLaunchPlan, codexNativeBrokerLaunchInput, validateCodexAppServerLaunchPlanRoots, type CodexAppServerLaunchPlan}
  from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {selectCodexAppServerPlatformTuple, type CodexAppServerPlatformTarget}
  from "../adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";
import type {CodexEffectCustodyAuthority} from "../adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
import type {CodexAppServerPermissionBoundary} from "../adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {dockerProviderProcessMountFacts, type DockerProviderProcessInput} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type {CodexCurrentKernelLaunchRecord} from "./codex-current-kernel-owner.js";
import {snapshotCodexCredentialOutputTokens} from "./codex-credential-output-inventory.js";
import {createDockerCustodiedProviderProcessRegistry} from "./docker-custodied-provider-process.js";

type AttemptInput = Parameters<CodexAppServerKernelAttemptFactory["prepare"]>[0];
export interface CreateDockerCodexCurrentKernelOwnerOptions {
  /** Accepted attempt authority, retained by trusted outer composition. */
  readonly attempt: AttemptInput;
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly credentialOutputInventory: CodexCurrentKernelLaunchRecord["credentialOutputInventory"];
  readonly effectCustody: CodexEffectCustodyAuthority;
  /** Same-object issued Codex plan; executable, arguments and environment come only from it. */
  readonly plan: CodexAppServerLaunchPlan;
  readonly platformTarget: CodexAppServerPlatformTarget;
  /** Actual retained lifecycle launch. Its exec contributes only uid/gid, request ID and deadline. */
  readonly process: DockerProviderProcessInput;
}
export interface DockerCodexCurrentKernelOwner {
  readonly provider: ContainedTurnKernelProviderPort;
  /** Closes this composition admission; the original lifecycle still owns all cleanup. */
  dispose(): void;
}

const attemptDigest = (input: AttemptInput) => digestContainedTurnCanonicalValue({
  adapterSnapshot: {...input.adapterSnapshot}, attemptId: input.attemptId,
  authorityVectorDigest: input.authorityVectorDigest, custodyId: input.custodyId,
  effectId: input.effectId, intent: {...input.intent}, operationId: input.operationId,
  providerAccessSnapshot: {...input.providerAccessSnapshot}, workspaceId: input.workspaceId,
});

const inert = <T extends object>(value: T): T => Object.freeze(snapshotCodexDataRecord(value)) as T;
/** Capture data before validation or any callback. Issued plan, boundary and
 * launch capabilities retain their identity; getters/proxies are never read. */
const captureOptions = (input: CreateDockerCodexCurrentKernelOwnerOptions): CreateDockerCodexCurrentKernelOwnerOptions => {
  const options = inert(input);
  const process = inert(options.process);
  const expected = inert(process.expected);
  const init = inert(process.init);
  const authority = inert(init.authority);
  const attempt = inert(options.attempt);
  return Object.freeze({...options, platformTarget: inert(options.platformTarget),
    attempt: Object.freeze({...attempt, adapterSnapshot: inert(attempt.adapterSnapshot),
      intent: inert(attempt.intent), providerAccessSnapshot: inert(attempt.providerAccessSnapshot)}),
    process: Object.freeze({...process, call: inert(process.call), exec: inert(process.exec),
      expected: Object.freeze({...expected, authority: inert(expected.authority)}),
      init: Object.freeze({...init, authority: Object.freeze({...authority, expectedIdentity: inert(authority.expectedIdentity)}),
        ...(process.preparedIo !== undefined || init.isObservationActive === undefined ? {} : {isObservationActive: init.isObservationActive.bind(process.init)})}),
    }),
  });
};

const captureProcessInput = (input: DockerProviderProcessInput, plan: CodexAppServerLaunchPlan,
  paths: CodexDockerPathProjection, admissionSignal: AbortSignal, isAdmitted: () => boolean): DockerProviderProcessInput => {
  const init = input.init;
  const isCurrentGeneration = init.isCurrentGeneration.bind(init);
  const environment = {...plan.environment, HOME: paths.codexHome, CODEX_HOME: paths.codexHome,
    TMPDIR: projectCodexDockerPrivatePath(paths, plan.tmpDir)};
  return Object.freeze({
    ...(input.preparedIo === undefined ? {} : {preparedIo: input.preparedIo}),
    launch: input.launch, // Never copy or fabricate the actual lifecycle capability.
    call: Object.freeze({...input.call, signal: AbortSignal.any([input.call.signal, admissionSignal])}),
    expected: Object.freeze({...input.expected, authority: Object.freeze({...input.expected.authority})}),
    exec: Object.freeze({gid: input.exec.gid, uid: input.exec.uid, requestId: input.exec.requestId,
      wallDeadlineUnixMs: input.exec.wallDeadlineUnixMs, executableSha256: plan.executableSha256,
      argv: Object.freeze([projectCodexDockerExecutable(paths, plan.executablePath), ...plan.arguments]),
      environment: Object.freeze(Object.entries(environment).map(([name, value]) => Object.freeze({name, value}))),
    }),
    init: input.preparedIo !== undefined ? init : Object.freeze({acknowledgementTimeoutMs: init.acknowledgementTimeoutMs, readyTimeoutMs: init.readyTimeoutMs,
      maximumStderrBytes: init.maximumStderrBytes, maximumStdoutBytes: init.maximumStdoutBytes,
      authority: Object.freeze({...init.authority, expectedIdentity: Object.freeze({...init.authority.expectedIdentity})}),
      isCurrentGeneration: (generation: string) => isCurrentGeneration(generation) && isAdmitted(),
      ...(init.isObservationActive === undefined ? {} : {isObservationActive: init.isObservationActive.bind(init)}),
      ...(init.signal === undefined ? {} : {signal: init.signal}),
      ...(init.monotonicNow === undefined ? {} : {monotonicNow: init.monotonicNow.bind(init)}),
    }),
  });
};

const assertPlatformBinding = (options: CreateDockerCodexCurrentKernelOwnerOptions): void => {
  const {attempt, plan} = options;
  if (!isIssuedCodexAppServerLaunchPlan(plan)) {throw new TypeError("Docker Codex requires an issued launch plan");}
  const tuple = selectCodexAppServerPlatformTuple(options.platformTarget);
  const snapshot = attempt.adapterSnapshot;
  if (tuple.platform !== "linux" || snapshot.provider !== "codex" || attempt.providerAccessSnapshot.provider !== "codex"
    || snapshot.adapterRevision !== tuple.adapterRevision || snapshot.binaryRevision !== tuple.binaryRevision
    || snapshot.capabilityManifestRevision !== tuple.protocolRevision || plan.binaryRevision !== tuple.binaryRevision
    || plan.executableSha256 !== tuple.binarySha256 || plan.intentMode !== attempt.intent.mode) {
    throw new TypeError("Docker Codex requires the exact Linux Codex platform binding");
  }
};

const assertBinding = (options: CreateDockerCodexCurrentKernelOwnerOptions): void => {
  assertPlatformBinding(options);
  const {attempt, boundary, plan} = options;
  const {key} = options.process.launch;
  if (key.operationId !== attempt.operationId || key.attemptId !== attempt.attemptId || key.custodyId !== attempt.custodyId
    || key.tenantId !== attempt.providerAccessSnapshot.tenantId || key.projectId !== attempt.providerAccessSnapshot.projectId
    || options.process.expected.custodyRef !== key.custodyId || options.process.expected.workspaceAuthorityPath !== plan.workspaceRef) {
    throw new TypeError("Docker Codex launch does not match retained attempt and workspace authority");
  }
  if (boundary.intentMode !== plan.intentMode || boundary.workspaceRef !== plan.workspaceRef
    || boundary.codexHome !== plan.codexHome || boundary.effectivePolicyDigest !== plan.effectivePolicyDigest
    || boundary.workspaceIdentity.device !== plan.workspaceIdentity.device || boundary.workspaceIdentity.inode !== plan.workspaceIdentity.inode
    || boundary.codexHomeIdentity.device !== plan.codexHomeIdentity.device || boundary.codexHomeIdentity.inode !== plan.codexHomeIdentity.inode) {
    throw new TypeError("Docker Codex permission boundary does not match the issued plan");
  }
  if (options.effectCustody === undefined) {throw new TypeError("Docker Codex requires effect custody");}
};

/** One explicitly selected, operation-scoped Docker connection to the existing
 * kernel adapter. Construction is effect-free; only the kernel's delegated
 * creator opens IO, after claim. This is not route admission or Host finality.
 * Outer Host composition retains the lifecycle for containment/reconciliation;
 * network ownership, Provider Access binding and native-file installation are
 * separate assembly prerequisites, not observations manufactured here.
 */
export const createDockerCodexCurrentKernelOwner = (
  options: CreateDockerCodexCurrentKernelOwnerOptions,
): DockerCodexCurrentKernelOwner => {
  options = captureOptions(options);
  assertBinding(options);
  const expectedAttempt = attemptDigest(options.attempt);
  const kernelCustodyId = options.attempt.custodyId;
  const plan = options.plan;
  const platformTarget = Object.freeze({...options.platformTarget});
  const mounts = dockerProviderProcessMountFacts(options.process.launch);
  const paths = createCodexDockerPathProjection(mounts, options.boundary);
  if (codexDockerProjectionSource(paths).privateRootSource !== plan.privateRootPath) {
    throw new TypeError("Docker Codex private root does not match the retained mount");
  }
  if (isCodexNativeBrokerLaunchPlan(plan)) {
    const nativePaths = codexNativeBrokerDockerPaths(codexNativeBrokerLaunchInput(plan).recipe);
    if (nativePaths === undefined || codexDockerProjectionSource(nativePaths).mounts !== mounts) {
      throw new TypeError("Docker Codex native recipe requires this launch's child paths");
    }
  }
  let disposed = false;
  const admission = new AbortController();
  const processInput = captureProcessInput(options.process, plan, paths, admission.signal, () => !disposed
    && !processInput.call.signal.aborted && processInput.init.signal?.aborted !== true
    && Date.now() < processInput.call.deadlineEpochMs);
  const registry = createDockerCustodiedProviderProcessRegistry();
  const protocol = new CodexAppServerContainedTurnProvider({
    boundary: options.boundary, dockerProjection: paths, effectCustody: options.effectCustody,
    manifest: {effectClass: "contained_unmediated_effect", supportedModes: Object.freeze(["analysis", "workspace-write"]),
      providerBinding: {...options.attempt.adapterSnapshot,
        credentialBindingDigest: options.attempt.providerAccessSnapshot.credentialBindingDigest,
        providerRouteRef: options.attempt.providerAccessSnapshot.providerRouteRef}},
    privateRootPath: plan.privateRootPath, tmpDir: plan.tmpDir, processes: registry.processes,
    ...(isCodexNativeBrokerLaunchPlan(plan) ? {nativeBrokerLaunchPlan: plan} : {}),
    sensitiveOutputTokens: snapshotCodexCredentialOutputTokens(options, options.attempt.providerAccessSnapshot),
  });
  let prepared = false;
  const assertOpen = () => {
    if (disposed || processInput.call.signal.aborted || processInput.init.signal?.aborted === true
      || Date.now() >= processInput.call.deadlineEpochMs
      || !processInput.init.isCurrentGeneration(processInput.expected.generation)) {
      throw new TypeError("Docker Codex attempt admission is closed");
    }
  };
  const attempts: CodexAppServerKernelAttemptFactory = Object.freeze({
    async prepare(input: AttemptInput) {
      assertOpen();
      if (prepared || attemptDigest(input) !== expectedAttempt) {throw new TypeError("Docker Codex attempt is unavailable");}
      prepared = true; // Fence before returning or awaiting any asynchronous effect.
      let created = false;
      return Object.freeze({
        async createProcess(isCancellationRequested: () => Promise<boolean>) {
          if (created) {throw new TypeError("Docker Codex prepared attempt is one-use");}
          created = true;
          assertOpen();
          if (await isCancellationRequested()) {throw new TypeError("Docker Codex start is cancelled");}
          assertOpen();
          validateCodexAppServerLaunchPlanRoots(plan);
          const opened = await registry.open(processInput);
          // A late acknowledged launch cannot start protocol after cutoff. The
          // actual lifecycle retains the session even when this creator rejects.
          if (await isCancellationRequested()) {throw new TypeError("Docker Codex start is cancelled");}
          assertOpen();
          return Object.freeze({custody: Object.freeze({custodyRef: opened.custodyRef}),
            kernelCustodyId, provider: protocol, workspaceRef: plan.workspaceRef});
        },
      });
    },
  });
  return Object.freeze({provider: new CodexAppServerCurrentKernelAdapter({attempts, platformTarget}),
    dispose() {disposed = true; admission.abort();}});
};
