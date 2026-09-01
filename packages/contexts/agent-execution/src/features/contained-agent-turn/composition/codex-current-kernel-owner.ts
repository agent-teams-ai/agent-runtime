import type { ContainedTurnProviderBinding } from "../contracts/contained-agent-turn.js";
import type { ContainedTurnKernelProviderPort } from "../application/ports/outbound/contained-turn-ports.js";
import { createCodexAppServerLaunchPlan } from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import type { CodexAppServerPermissionBoundary } from "../adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {
  CodexAppServerCurrentKernelAdapter,
  type CodexAppServerKernelAttemptFactory,
} from "../adapters/outbound/codex-app-server/codex-app-server-current-kernel-adapter.js";
import { CodexAppServerContainedTurnProvider } from "../adapters/outbound/codex-app-server/codex-app-server-contained-turn-provider.js";
import type { CodexEffectCustodyAuthority } from "../adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
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
type AttemptInput = Parameters<CodexAppServerKernelAttemptFactory["prepare"]>[0];
type OwnerPrepareInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["prepare"]>[0];
type OwnerRetireInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["retire"]>[0];
type OwnerRetainInput = Parameters<ContainedTurnKernelCustodyAttemptOwner["retain"]>[0];
type Processes = CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;

export interface CodexCurrentKernelLaunchRecord {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly executablePath: string;
  readonly privateRootPath: string;
  readonly tmpDir: string;
}
export interface CodexCurrentKernelLaunchRecordResolver {
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
  }>): Promise<CodexCurrentKernelLaunchRecord | undefined>;
}
export interface CreateCodexCurrentKernelOwnerOptions {
  /** Mandatory opened-object authority for every Codex command/file effect lifecycle. */
  readonly effectCustody: CodexEffectCustodyAuthority;
  readonly hostBootId: string;
  readonly hostCustody: ContainedTurnHostCustodyPort & Processes;
  readonly hostInstanceId: string;
  readonly launchRecords: CodexCurrentKernelLaunchRecordResolver;
  readonly workspaceOwner: ContainedTurnKernelWorkspaceOwner;
}
export interface CodexCurrentKernelOwner {
  readonly custody: ContainedTurnKernelCustodyAdapter;
  readonly provider: ContainedTurnKernelProviderPort;
  dispose(): void;
}

interface PreparedRecord {
  readonly binding: ContainedTurnProviderBinding;
  readonly kernel: KernelOpen;
  readonly plan: HostCustodyLaunchPlan;
  readonly record: CodexCurrentKernelLaunchRecord;
  readonly workspaceRef: string;
  custodyRef?: string;
}
const sameAttempt = (record: PreparedRecord, input: AttemptInput): boolean =>
  record.kernel.operationId === input.operationId && record.kernel.attemptId === input.attemptId &&
  record.kernel.custodyId === input.custodyId && record.kernel.effectId === input.effectId &&
  record.kernel.authorityVectorDigest === input.authorityVectorDigest &&
  record.kernel.workspaceId === input.workspaceId && record.kernel.intentMode === input.intent.mode &&
  record.binding.provider === input.adapterSnapshot.provider &&
  record.binding.adapterRevision === input.adapterSnapshot.adapterRevision &&
  record.binding.binaryRevision === input.adapterSnapshot.binaryRevision &&
  record.binding.capabilityManifestRevision === input.adapterSnapshot.capabilityManifestRevision &&
  record.binding.credentialBindingDigest === input.providerAccessSnapshot.credentialBindingDigest &&
  record.binding.providerRouteRef === input.providerAccessSnapshot.providerRouteRef;

export const createCodexCurrentKernelOwner = (
  options: CreateCodexCurrentKernelOwnerOptions,
): CodexCurrentKernelOwner => {
  const custodyOwner = options.effectCustody;
  const custodyDescriptor = custodyOwner === undefined
    ? undefined : Object.getOwnPropertyDescriptor(custodyOwner, "admit");
  if (custodyDescriptor === undefined || !("value" in custodyDescriptor)
    || typeof custodyDescriptor.value !== "function") {
    throw new TypeError("Codex current-kernel workspace-write requires effect custody");
  }
  const admit = custodyDescriptor.value as CodexEffectCustodyAuthority["admit"];
  const effectCustody: CodexEffectCustodyAuthority = Object.freeze({
    admit: (request: Parameters<CodexEffectCustodyAuthority["admit"]>[0]) => admit.call(custodyOwner, request),
  });
  const records = new Map<string, PreparedRecord>();
  const processes: CustodiedProviderProcessRegistry = Object.freeze({
    get: options.hostCustody.get.bind(options.hostCustody),
  });
  let disposed = false;
  const attempts: CodexAppServerKernelAttemptFactory = Object.freeze({
    async prepare(input: AttemptInput) {
      if (disposed) {throw new TypeError("Codex current-kernel owner is disposed");}
      const record = records.get(input.custodyId);
      if (record === undefined || record.custodyRef === undefined || !sameAttempt(record, input)) {
        throw new TypeError("Codex prepared attempt identity mismatch");
      }
      records.delete(input.custodyId);
      let created = false;
      return Object.freeze({
        createProcess: () => {
          if (created) {throw new TypeError("Codex prepared attempt is one-use");}
          created = true;
          options.hostCustody.start(record.custodyRef!, {
            arguments: record.plan.arguments,
            command: record.plan.executablePath,
            cwd: "/proc/self/fd/4",
            environment: record.plan.environment,
            signal: new AbortController().signal,
          });
          const provider = new CodexAppServerContainedTurnProvider({
            boundary: record.record.boundary,
            effectCustody,
            manifest: {
              effectClass: "contained_unmediated_effect",
              providerBinding: record.binding,
              supportedModes: Object.freeze(["analysis", "workspace-write"]),
            },
            processes,
            tmpDir: record.record.tmpDir,
          });
          return Object.freeze({
            custody: Object.freeze({ custodyRef: record.custodyRef! }),
            kernelCustodyId: record.kernel.custodyId, provider,
            workspaceRef: record.workspaceRef,
          });
        },
      });
    },
  });
  const attemptOwner: ContainedTurnKernelCustodyAttemptOwner = Object.freeze({
    async prepare(input: OwnerPrepareInput) {
      if (disposed || records.has(input.kernel.custodyId)) {
        throw new TypeError("Codex current-kernel attempt is unavailable");
      }
      const launch = await options.launchRecords.resolve({
        attemptId: input.kernel.attemptId, authorityVectorDigest: input.kernel.authorityVectorDigest,
        custodyId: input.kernel.custodyId, effectId: input.kernel.effectId,
        intentMode: input.kernel.intentMode, operationId: input.kernel.operationId,
        providerBinding: input.providerBinding, workspaceAuthority: input.workspaceAuthority,
        workspaceId: input.kernel.workspaceId,
      });
      if (launch === undefined || launch.boundary.workspaceRef !== input.workspaceAuthority.canonicalPath) {
        throw new TypeError("Codex launch record is unavailable or workspace-bound incorrectly");
      }
      const plan = createCodexAppServerLaunchPlan({
        boundary: launch.boundary, executablePath: launch.executablePath,
        intentMode: input.kernel.intentMode, privateRootPath: launch.privateRootPath, tmpDir: launch.tmpDir,
      });
      records.set(input.kernel.custodyId, {
        binding: input.providerBinding, kernel: input.kernel, plan, record: launch,
        workspaceRef: input.workspaceAuthority.canonicalPath,
      });
      return plan;
    },
    retain(input: OwnerRetainInput) {
      const record = records.get(input.kernel.custodyId);
      if (record === undefined || record.kernel.attemptId !== input.kernel.attemptId ||
          record.kernel.operationId !== input.kernel.operationId || record.workspaceRef !== input.workspaceRef ||
          record.custodyRef !== undefined) {
        throw new TypeError("Codex Host reservation identity mismatch");
      }
      record.custodyRef = input.underlyingCustodyRef;
    },
    retire(input: OwnerRetireInput) {records.delete(input.custodyId);},
  });
  const custody = new ContainedTurnKernelCustodyAdapter(options.hostCustody, {
    attemptOwner, hostBootId: options.hostBootId, hostInstanceId: options.hostInstanceId,
    workspaceOwner: options.workspaceOwner,
  });
  return Object.freeze({
    custody,
    dispose() {disposed = true; records.clear();},
    provider: new CodexAppServerCurrentKernelAdapter({ attempts }),
  });
};
