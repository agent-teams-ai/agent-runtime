import {createHostPrivateRootOwnerFactory} from "./host-private-root-owner.js";
import {createDockerHostReservationOwners} from "./docker-host-reservation-owners.js";
import {snapshotDockerImageInitLock, prepareDockerProviderProcessIo, dockerProviderProcessMountFacts, isConcreteLinuxDockerLifecycle,
  type DockerImageInitLock, type PreparedDockerProviderIo, type DockerProviderProcessInput, type DockerHostCustodyLifecycle}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {createCodexDockerPathProjection, CodexAppServerCurrentKernelAdapter} from "../adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import {randomUUID} from "node:crypto";
import {custodyDataRecord, sameHostCustodyBinding, isHostCustodyDataCallback, ContainedTurnKernelCustodyAdapter, type ContainedTurnKernelCustodyAttemptOwner,
  type ContainedTurnKernelWorkspaceOwner} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {DockerKernelHostCustody} from "./docker-kernel-host-custody.js";
import {createCodexAppServerFinalizableLaunchPlan, isCodexNativeBrokerLaunchPlan, type CodexAppServerLaunchPlan}
  from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import type {ContainedTurnKernelProviderPort} from "../application/ports/outbound/contained-turn-ports.js";
import type {CodexCurrentKernelLaunchRecord, CodexCurrentKernelLaunchRecordResolver} from "./codex-current-kernel-owner.js";
import {createDockerCodexCurrentKernelOwner, captureDockerCodexProcessInput, type CreateDockerCodexCurrentKernelOwnerOptions,
  type DockerCodexCurrentKernelOwner} from "./docker-codex-current-kernel-owner.js";
import {createDockerLinuxPostClaimOwner, type DockerLinuxPostClaimDependencies, type DockerLinuxClaimedJoin,
  type DockerLinuxPostClaimOwner, type DockerLinuxClaimedPreparation} from "./docker-linux-post-claim-preparation.js";

type Prepare = Parameters<ContainedTurnKernelCustodyAttemptOwner["prepare"]>[0];
type Kernel = Prepare["kernel"];
type FinalizeInput = Parameters<DockerLinuxClaimedJoin<PreparedDockerProviderIo>["finishClaimed"]>[0];
const apply = Reflect.apply;
export interface CreateDockerCodexHostKernelOwnerOptions {
  readonly hostBootId: string;
  readonly hostInstanceId: string;
  readonly workspaceOwner: ContainedTurnKernelWorkspaceOwner;
  readonly launchRecords: CodexCurrentKernelLaunchRecordResolver;
  readonly platformTarget: CreateDockerCodexCurrentKernelOwnerOptions["platformTarget"];
  readonly effectCustody: CreateDockerCodexCurrentKernelOwnerOptions["effectCustody"];
  readonly cleanupMilliseconds: number;
  /** Independently selected immutable image/interpreter/closed init bundle lock.
   * Missing selection refuses before allocation; observed bytes cannot select it. */
  readonly imageInitLock?: DockerImageInitLock;
  /** Trusted, operation-scoped resource selection. No effects during selection. */
  preparation(input: Readonly<{kernel: Kernel; record: CodexCurrentKernelLaunchRecord}>): DockerLinuxPostClaimDependencies;
  /** Unavailable until the native broker owner binds this HTTP reservation,
   * installed first-write route and issued Docker-path native material. Missing
   * finalization refuses before allocation; there is no ordinary-plan fallback. */
  readonly finishClaimed?: (input: FinalizeInput & Readonly<{record: CodexCurrentKernelLaunchRecord; originalPlan: CodexAppServerLaunchPlan}>) =>
    ReturnType<DockerLinuxClaimedJoin<PreparedDockerProviderIo>["finishClaimed"]>;
}
interface Retained {
  readonly kernel: Kernel;
  readonly record: CodexCurrentKernelLaunchRecord;
  readonly originalPlan: CodexAppServerLaunchPlan;
  ref?: string;
  owner?: DockerLinuxPostClaimOwner<PreparedDockerProviderIo>;
  claimed?: DockerLinuxClaimedPreparation;
  process?: DockerProviderProcessInput;
  provider?: DockerCodexCurrentKernelOwner;
  used: boolean;
}

/** Private Docker selection, with exactly the existing custody/provider product
 * surface. Construction retains functions only. No Node final-launch seam. */
export const createDockerCodexHostKernelOwner = (value: CreateDockerCodexHostKernelOwnerOptions) => {
  const data = custodyDataRecord(value);
  const options = Object.freeze({...data, platformTarget: Object.freeze({...custodyDataRecord(data.platformTarget)})});
  if (options.platformTarget.platform !== "linux") {throw new TypeError("Docker requires Linux");}
  const finishClaimed = options.finishClaimed;
  if (finishClaimed !== undefined && !isHostCustodyDataCallback(finishClaimed)) {
    throw new TypeError("Docker native finalizer must be a callable data property");
  }
  const imageInitLock = options.imageInitLock === undefined ? undefined : snapshotDockerImageInitLock(options.imageInitLock);
  const roots = createHostPrivateRootOwnerFactory({hostInstanceId: options.hostInstanceId, hostBootId: options.hostBootId});
  const records = new Map<string, Retained>();
  const raw = new DockerKernelHostCustody(options.cleanupMilliseconds);
  let disposed = false;
  const attemptOwner: ContainedTurnKernelCustodyAttemptOwner = Object.freeze({
    async prepare(input: Prepare) {
      if (disposed || records.has(input.kernel.custodyId) || records.size >= 64) {throw new TypeError("Docker attempt unavailable");}
      const kernel = Object.freeze({...input.kernel, adapterSnapshot: Object.freeze({...input.kernel.adapterSnapshot}),
        providerAccessSnapshot: Object.freeze({...input.kernel.providerAccessSnapshot})});
      const record = await options.launchRecords.resolve({attemptId: kernel.attemptId, authorityVectorDigest: kernel.authorityVectorDigest,
        custodyId: kernel.custodyId, credentialBindingDigest: kernel.providerAccessSnapshot.credentialBindingDigest,
        credentialGeneration: kernel.providerAccessSnapshot.credentialGeneration, effectId: kernel.effectId,
        intentMode: kernel.intentMode, operationId: kernel.operationId, providerBinding: input.providerBinding,
        workspaceAuthority: input.workspaceAuthority, workspaceId: kernel.workspaceId});
      if (disposed || records.has(kernel.custodyId) || record === undefined || record.boundary.workspaceRef !== input.workspaceAuthority.canonicalPath) {
        throw new TypeError("Docker launch record unavailable");
      }
      const plan = createCodexAppServerFinalizableLaunchPlan({boundary: record.boundary, executablePath: record.executablePath,
        intentMode: kernel.intentMode, platformTarget: options.platformTarget, privateRootPath: record.privateRootPath,
        tmpDir: record.tmpDir}, kernel.providerAccessSnapshot);
      records.set(kernel.custodyId, {kernel, record, originalPlan: plan, used: false});
      return plan;
    },
    retain(input: Parameters<ContainedTurnKernelCustodyAttemptOwner["retain"]>[0]) {
      const retained = records.get(input.kernel.custodyId);
      if (disposed || retained === undefined || retained.ref !== undefined || !sameHostCustodyBinding(retained.kernel, input.kernel)) {
        throw new TypeError("Docker reservation binding conflict");
      }
      retained.ref = input.underlyingCustodyRef;
    },
    retire(input: Parameters<ContainedTurnKernelCustodyAttemptOwner["retire"]>[0]) {
      const retained = records.get(input.custodyId);
      // Failed preparation still owns cleanup; never evict its debt.
      if (retained?.ref === undefined) {records.delete(input.custodyId);}
    },
  });
  const preparation = Object.freeze({async prepareClaimed(claimed: DockerLinuxClaimedPreparation) {
    const retained = [...records.values()].find(record => record.ref === claimed.underlyingCustodyRef);
    if (disposed || retained === undefined || retained.claimed !== undefined || finishClaimed === undefined || imageInitLock === undefined) {
      return Object.freeze({kind: "unsupported" as const, reason: "broker" as const});
    }
    retained.claimed = claimed; // One-use before calling resource selection.
    const dependencies = options.preparation({kernel: retained.kernel, record: retained.record});
    const deadlineEpochMs = Date.now() + dependencies.deadlines.routeLifetimeMs;
    const hostOwners = createDockerHostReservationOwners({roots, raw, custodyRef: claimed.underlyingCustodyRef,
      dependencies, lock: imageInitLock, cutoffProvider: () => retained.provider?.dispose()});
    let lifecycle: DockerHostCustodyLifecycle | undefined;
    const owner = createDockerLinuxPostClaimOwner({...dependencies,
      openLifecycle(policy) {
        if (lifecycle !== undefined) {throw new TypeError("Docker lifecycle selection is one-use");}
        lifecycle = dependencies.openLifecycle(policy);
        if (!isConcreteLinuxDockerLifecycle(lifecycle)) {throw new TypeError("Docker requires the concrete Linux residue owner");}
        return lifecycle;
      }}, {
      ...hostOwners.hooks,
      prepareProviderIo({launch, init}) {
        if (lifecycle === undefined) {throw new TypeError("Docker lifecycle unavailable");}
        const process = {launch, init, expected: Object.freeze({authority: launch.authority, custodyRef: launch.key.custodyId,
          generation: init.authority.generation, workspaceAuthorityPath: retained.record.boundary.workspaceRef}),
          call: Object.freeze({signal: claimed.signal, deadlineEpochMs}),
          exec: Object.freeze({requestId: randomUUID(), uid: Number(dependencies.enginePolicy.user.split(":")[0]),
            gid: Number(dependencies.enginePolicy.user.split(":")[1]), wallDeadlineUnixMs: deadlineEpochMs,
            argv: Object.freeze([]), environment: Object.freeze([]), executableSha256: ""})};
        const providerIo = prepareDockerProviderProcessIo(process);
        retained.process = Object.freeze({...process, preparedIo: providerIo});
        raw.reservation(claimed.underlyingCustodyRef).evidence.attach(lifecycle, launch, providerIo);
        return providerIo;
      },
      async finishClaimed(input) {
        const result = await apply(finishClaimed, value, [{...input, record: retained.record, originalPlan: retained.originalPlan}]);
        if (!isCodexNativeBrokerLaunchPlan(result.plan)) {throw new TypeError("Docker native broker finalization unavailable");}
        const process = retained.process!;
        const paths = createCodexDockerPathProjection(dockerProviderProcessMountFacts(input.launch), retained.record.boundary);
        const actual = captureDockerCodexProcessInput(process, result.plan, paths, claimed.signal, () => !disposed);
        raw.reservation(claimed.underlyingCustodyRef).evidence.finalize(result.plan, actual.exec);
        return result;
      },
    });
    retained.owner = owner;
    hostOwners.attach(owner);
    return owner.preparation.prepareClaimed(claimed);
  }});
  const custody = new ContainedTurnKernelCustodyAdapter(raw, {attemptOwner, workspaceOwner: options.workspaceOwner,
    hostBootId: options.hostBootId, hostInstanceId: options.hostInstanceId, postClaimPreparation: preparation});
  const selection = new CodexAppServerCurrentKernelAdapter({platformTarget: options.platformTarget,
    attempts: {async prepare() {throw new TypeError("Docker execution requires retained preparation");}}});
  const provider: ContainedTurnKernelProviderPort = Object.freeze({adapterSnapshot: selection.adapterSnapshot,
    manifest: selection.manifest, async execute(input: Parameters<ContainedTurnKernelProviderPort["execute"]>[0]) {
    const retained = records.get(input.custodyId);
    if (disposed || retained === undefined || retained.used || retained.owner === undefined || retained.claimed === undefined ||
      retained.process === undefined || retained.kernel.operationId !== input.operationId || retained.kernel.attemptId !== input.attemptId ||
      retained.kernel.effectId !== input.effectId || retained.kernel.workspaceId !== input.workspaceId ||
      retained.kernel.authorityVectorDigest !== input.authorityVectorDigest || retained.kernel.intentMode !== input.intent.mode ||
      !sameHostCustodyBinding(retained.kernel.adapterSnapshot, input.adapterSnapshot) ||
      !sameHostCustodyBinding(retained.kernel.providerAccessSnapshot, input.providerAccessSnapshot)) {throw new TypeError("Docker prepared attempt conflict");}
    retained.used = true;
    const prepared = retained.owner.takePrepared(retained.claimed);
    const owner = createDockerCodexCurrentKernelOwner({attempt: input, boundary: retained.record.boundary,
      credentialOutputInventory: retained.record.credentialOutputInventory, effectCustody: options.effectCustody,
      plan: prepared.plan, platformTarget: options.platformTarget, process: retained.process});
    retained.provider = owner;
    return owner.provider.execute(input);
  }});
  return Object.freeze({custody, provider, dispose() {
    disposed = true;
    for (const record of records.values()) {record.provider?.dispose();}
    raw.dispose();
  }});
};
