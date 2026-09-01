import type { ContainedTurnProviderBinding } from "../contracts/contained-agent-turn.js";
import type {
  ContainedTurnKernelProviderPort,
} from "../application/ports/outbound/contained-turn-ports.js";
import {
  CONTAINED_TURN_REQUIRED_PROOF_KINDS,
} from "../domain/contained-turn-authority.js";
import type {
  ContainedTurnCapabilityManifest,
  ContainedTurnProviderAdapterSnapshot,
} from "../domain/contained-turn-authority.js";
import {
  ClaudeAgentSdkCurrentKernelAdapter,
  captureClaudePrivateDirectoryCustody,
  createClaudeAgentSdkLaunchPlan,
  selectClaudeAgentSdkPlatformTuple,
  type ClaudeAgentSdkContainedTurnProviderOptions,
  type ClaudeAgentSdkKernelPrivateExecution,
  type ClaudeAgentSdkKernelPrivateExecutionResolver,
  type ClaudeAgentSdkPlatformTuple,
  type ClaudeAgentSdkPrivateProjection,
} from "../adapters/outbound/claude-agent-sdk/claude-current-kernel-entrypoint.js";
import type { PrivateDirectoryCustodyPort } from "../adapters/outbound/provider-delegation-ports/private-directory-custody-port.js";
import type {
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
  HostCustodyLaunchPlan,
} from "../adapters/outbound/host-custody/custodied-provider-process.js";
import {
  ContainedTurnKernelCustodyAdapter,
  type ContainedTurnHostCustodyPort,
  type ContainedTurnKernelCustodyAttemptOwner,
  type ContainedTurnKernelWorkspaceOwner,
} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";

type KernelOpen = Parameters<ContainedTurnKernelCustodyAttemptOwner["prepare"]>[0]["kernel"];
type Processes = CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
type OwnerPrepareInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["prepare"]>[0];
type OwnerRetireInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["retire"]>[0];
type OwnerRetainInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["retain"]>[0];

export interface ClaudeCurrentKernelLaunchRecord {
  readonly privateProjection: ClaudeAgentSdkPrivateProjection;
  readonly privateRootPath: string;
}
export interface ClaudeCurrentKernelLaunchRecordResolver {
  resolve(input: Readonly<{
    attemptId: KernelOpen["attemptId"];
    authorityVectorDigest: KernelOpen["authorityVectorDigest"];
    custodyId: KernelOpen["custodyId"];
    effectId: KernelOpen["effectId"];
    intentMode: KernelOpen["intentMode"];
    operationId: KernelOpen["operationId"];
    providerBinding: ContainedTurnProviderBinding;
    workspaceAuthority: Parameters<ContainedTurnKernelCustodyAttemptOwner["prepare"]>[0]["workspaceAuthority"];
    workspaceId: KernelOpen["workspaceId"];
  }>): Promise<ClaudeCurrentKernelLaunchRecord | undefined>;
}
export interface CreateClaudeCurrentKernelOwnerOptions {
  readonly adapterSnapshot: ContainedTurnProviderAdapterSnapshot;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly hostBootId: string;
  readonly hostCustody: ContainedTurnHostCustodyPort & Processes;
  readonly hostInstanceId: string;
  readonly launchRecords: ClaudeCurrentKernelLaunchRecordResolver;
  readonly manifest: ContainedTurnCapabilityManifest;
  readonly platformTuple: ClaudeAgentSdkPlatformTuple;
  readonly privateDirectoryCustody: PrivateDirectoryCustodyPort;
  readonly queryFactory?: ClaudeAgentSdkContainedTurnProviderOptions["queryFactory"];
  readonly workspaceOwner: ContainedTurnKernelWorkspaceOwner;
}
export interface ClaudeCurrentKernelOwner {
  readonly custody: ContainedTurnKernelCustodyAdapter;
  readonly provider: ContainedTurnKernelProviderPort;
  dispose(): void;
}
interface PreparedRecord {
  readonly binding: ContainedTurnProviderBinding;
  readonly kernel: KernelOpen;
  readonly plan: HostCustodyLaunchPlan;
  readonly privateProjection: ClaudeAgentSdkPrivateProjection;
  readonly workspaceRef: string;
  custodyRef?: string;
}
type PrivateExecutionInput = Parameters<ClaudeAgentSdkKernelPrivateExecutionResolver["consume"]>[0];
const exactExecution = (record: PreparedRecord, input: PrivateExecutionInput): boolean =>
  record.kernel.attemptId === input.attemptId &&
  record.kernel.authorityVectorDigest === input.authorityVectorDigest && record.kernel.custodyId === input.custodyId &&
  record.kernel.effectId === input.effectId && record.kernel.operationId === input.operationId &&
  record.kernel.workspaceId === input.workspaceId &&
  record.binding.provider === input.providerBinding.provider &&
  record.binding.adapterRevision === input.providerBinding.adapterRevision &&
  record.binding.binaryRevision === input.providerBinding.binaryRevision &&
  record.binding.capabilityManifestRevision === input.providerBinding.capabilityManifestRevision &&
  record.binding.credentialBindingDigest === input.providerBinding.credentialBindingDigest &&
  record.binding.providerRouteRef === input.providerBinding.providerRouteRef;

const exactStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const assertProductionTuple = (options: CreateClaudeCurrentKernelOwnerOptions): void => {
  const tuple = selectClaudeAgentSdkPlatformTuple(
    options.platformTuple.platform, options.platformTuple.architecture,
  );
  const snapshot = options.adapterSnapshot;
  const manifest = options.manifest;
  if (
    options.platformTuple !== tuple ||
    snapshot.provider !== "claude" ||
    snapshot.adapterRevision !== tuple.adapterRevision ||
    snapshot.binaryRevision !== tuple.binaryRevision ||
    snapshot.capabilityManifestRevision !== tuple.manifestRevision ||
    options.executableSha256 !== tuple.executableSha256 ||
    manifest.provider !== "claude" ||
    manifest.manifestVersion !== 1 ||
    manifest.manifestRevision !== tuple.manifestRevision ||
    manifest.resourceScopeRevision !== tuple.resourceScopeRevision ||
    manifest.effectClass !== "contained_unmediated_effect" ||
    manifest.effectCardinality !== "one_coarse_effect_per_operation" ||
    manifest.providerAttemptCardinality !== "at_most_one" ||
    manifest.unknownCapabilityPolicy !== "fail_closed" ||
    !exactStringArray(manifest.supportedModes, ["analysis", "workspace-write"]) ||
    !exactStringArray(manifest.requiredProofKinds, CONTAINED_TURN_REQUIRED_PROOF_KINDS)
  ) {
    throw new TypeError(
      `Claude production composition requires SDK ${tuple.sdkVersion}, bundled CLI ${tuple.bundledCliVersion}, and its exact ADR-0010 tuple`,
    );
  }
};

export const createClaudeCurrentKernelOwner = (
  options: CreateClaudeCurrentKernelOwnerOptions,
): ClaudeCurrentKernelOwner => {
  assertProductionTuple(options);
  const records = new Map<string, PreparedRecord>();
  const privateDirectoryCustody = captureClaudePrivateDirectoryCustody(options.privateDirectoryCustody);
  const processes: Processes = Object.freeze({
    get: options.hostCustody.get.bind(options.hostCustody),
    start: options.hostCustody.start.bind(options.hostCustody),
  });
  let disposed = false;
  const privateExecutions: ClaudeAgentSdkKernelPrivateExecutionResolver = Object.freeze({
    async consume<Result>(input: PrivateExecutionInput,
      execute: (execution: ClaudeAgentSdkKernelPrivateExecution) => Promise<Result>): Promise<Result | undefined> {
      if (disposed) {return;}
      const record = records.get(input.custodyId);
      if (record === undefined || record.custodyRef === undefined || !exactExecution(record, input)) {return;}
      records.delete(input.custodyId);
      return execute(Object.freeze({
        custodyRef: record.custodyRef,
        kernelCustodyId: record.kernel.custodyId,
        privateProjection: record.privateProjection,
        providerBinding: record.binding,
        workspaceRef: record.workspaceRef,
      }));
    },
  });
  const attemptOwner: ContainedTurnKernelCustodyAttemptOwner = Object.freeze({
    async prepare(input: OwnerPrepareInput) {
      if (disposed || records.has(input.kernel.custodyId)) {
        throw new TypeError("Claude current-kernel attempt is unavailable");
      }
      const launch = await options.launchRecords.resolve({
        attemptId: input.kernel.attemptId, authorityVectorDigest: input.kernel.authorityVectorDigest,
        custodyId: input.kernel.custodyId, effectId: input.kernel.effectId,
        intentMode: input.kernel.intentMode, operationId: input.kernel.operationId,
        providerBinding: input.providerBinding, workspaceAuthority: input.workspaceAuthority,
        workspaceId: input.kernel.workspaceId,
      });
      if (launch === undefined) {throw new TypeError("Claude launch record is unavailable");}
      const plan = await createClaudeAgentSdkLaunchPlan({
        binaryRevision: options.adapterSnapshot.binaryRevision,
        executablePath: options.executablePath, executableSha256: options.executableSha256,
        intentMode: input.kernel.intentMode, privateProjection: launch.privateProjection,
        platformTuple: options.platformTuple,
        privateDirectoryCustody, privateRootPath: launch.privateRootPath,
        workspaceRef: input.workspaceAuthority.canonicalPath,
      });
      records.set(input.kernel.custodyId, {
        binding: input.providerBinding, kernel: input.kernel, plan, privateProjection: launch.privateProjection,
        workspaceRef: input.workspaceAuthority.canonicalPath,
      });
      return plan;
    },
    retain(input: OwnerRetainInput) {
      const record = records.get(input.kernel.custodyId);
      if (record === undefined || record.kernel.attemptId !== input.kernel.attemptId ||
          record.kernel.operationId !== input.kernel.operationId || record.workspaceRef !== input.workspaceRef ||
          record.custodyRef !== undefined) {
        throw new TypeError("Claude Host reservation identity mismatch");
      }
      record.custodyRef = input.underlyingCustodyRef;
    },
    retire(input: OwnerRetireInput) {records.delete(input.custodyId);},
  });
  const custody = new ContainedTurnKernelCustodyAdapter(options.hostCustody, {
    attemptOwner, hostBootId: options.hostBootId, hostInstanceId: options.hostInstanceId,
    workspaceOwner: options.workspaceOwner,
  });
  const provider = new ClaudeAgentSdkCurrentKernelAdapter({
    adapterSnapshot: options.adapterSnapshot, executablePath: options.executablePath,
    manifest: options.manifest, privateDirectoryCustody, privateExecutions, processes,
    platformTuple: options.platformTuple,
    ...(options.queryFactory === undefined ? {} : { queryFactory: options.queryFactory }),
  });
  return Object.freeze({custody, dispose() {disposed = true; records.clear();}, provider});
};
