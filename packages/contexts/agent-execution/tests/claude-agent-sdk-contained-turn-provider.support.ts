import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after } from "node:test";

import {
  ClaudeAgentSdkContainedTurnProvider,
  type ClaudeAgentSdkContainedTurnProviderOptions,
  type ClaudeAgentSdkControlClock,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-contained-turn-provider.js";
import {
  ClaudeAgentSdkCurrentKernelAdapter,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-current-kernel-adapter.js";
import { digestContainedTurnCanonicalValue } from "../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import {
  claudeAgentSdkArguments,
  createClaudeAgentSdkPrivateProjection,
} from "../dist/features/contained-agent-turn/adapters/outbound/claude-agent-sdk/claude-agent-sdk-launch-plan.js";
import type {
  CustodiedProviderProcess,
  CustodiedSdkProcess,
} from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";

export { nextTurn };

const custodyRoot = await mkdtemp(join(tmpdir(), "ar-claude-provider-test-"));
after(async () => {
  await rm(custodyRoot, { recursive: true, force: true });
});
export const workspaceRef = join(custodyRoot, "workspace");
export const privateRoot = `${workspaceRef}-host-private`;
await Promise.all([
  mkdir(workspaceRef, { mode: 0o700 }),
  mkdir(join(privateRoot, "config"), { mode: 0o700, recursive: true }),
  mkdir(join(privateRoot, "home"), { mode: 0o700, recursive: true }),
  mkdir(join(privateRoot, "tmp"), { mode: 0o700, recursive: true }),
]);

export const executablePath = "/synthetic/claude";
export const privateProjection = createClaudeAgentSdkPrivateProjection({
  configRoot: join(privateRoot, "config"),
  homeRoot: join(privateRoot, "home"),
  projectionRef: "projection:claude-test",
  tempRoot: join(privateRoot, "tmp"),
  workspaceRef,
});
export const binding = Object.freeze({
  adapterRevision: "claude-agent-sdk-contained-turn:0.3.251",
  binaryRevision: "@anthropic-ai/claude-agent-sdk:0.3.251+synthetic",
  capabilityManifestRevision: "contained-turn:v1:claude-agent-sdk:0.3.251",
  credentialBindingDigest: "credential:synthetic",
  provider: "claude" as const,
  providerRouteRef: "route:synthetic",
});
const manifest = Object.freeze({
  effectClass: "contained_unmediated_effect" as const,
  providerBinding: binding,
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
});
const privateProjections = Object.freeze({ resolve: () => privateProjection });

export const input = (mode: "analysis" | "workspace-write" = "analysis") => ({
  attemptId: "attempt:claude-test",
  custody: { custodyRef: "custody:claude-test" },
  effectId: "effect:claude-test",
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode, prompt: "reply exactly OK" },
  isCancellationRequested: async () => false,
  operationId: "operation:claude-test",
  workspaceRef,
});

export const inertProcess = (): CustodiedSdkProcess => ({
  exitCode: null,
  kill: () => true,
  killed: false,
  off: () => {},
  on: () => {},
  once: () => {},
  signalCode: null,
  stdin: undefined as never,
  stdout: undefined as never,
});
const emptyByteStream = (): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({ done: true, value: new Uint8Array() }),
  }),
});
export const inertRegistryProcess = (): CustodiedProviderProcess => ({
  closeInput: async () => {},
  custodyRef: "custody:claude-test",
  stderr: emptyByteStream(),
  stdout: emptyByteStream(),
  waitForExit: async () => ({ code: 0, signal: null }),
  write: async () => {},
});

export type QueryFactory = NonNullable<ClaudeAgentSdkContainedTurnProviderOptions["queryFactory"]>;
export const provider = (
  queryFactory: QueryFactory,
  options: Partial<ClaudeAgentSdkContainedTurnProviderOptions> = {},
) => new ClaudeAgentSdkContainedTurnProvider({
  cancellationPollMs: 1,
  executablePath,
  interruptGraceMs: 20,
  manifest,
  privateProjections,
  processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
  queryFactory,
  turnTimeoutMs: 1_000,
  ...options,
});

export const success = (id = "one") => ({
  is_error: false,
  result: "OK",
  session_id: `session:${id}`,
  subtype: "success" as const,
  type: "result" as const,
  uuid: `result:${id}`,
});
export const delta = (text: string) => ({
  event: { delta: { text, type: "text_delta" }, type: "content_block_delta" },
  parent_tool_use_id: null,
  session_id: "session:stream",
  type: "stream_event",
  uuid: "stream:event",
});

export class ManualClock implements ClaudeAgentSdkControlClock {
  #advanceBeforeRead: { milliseconds: number; reads: number } | undefined;
  #elapsed = 0;
  #reported = 0;
  readonly #waiters: Array<{
    due: number;
    reject: (error: Error) => void;
    resolve: () => void;
    signal: AbortSignal;
  }> = [];

  public now(): number {
    if (this.#advanceBeforeRead?.reads === 0) {
      const { milliseconds } = this.#advanceBeforeRead;
      this.#advanceBeforeRead = undefined;
      this.advanceWithoutDelivery(milliseconds);
    } else if (this.#advanceBeforeRead !== undefined) {
      this.#advanceBeforeRead.reads -= 1;
    }
    return this.#reported;
  }

  public wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const waiter = { due: this.#elapsed + milliseconds, reject, resolve, signal };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  public advance(milliseconds: number): void {
    this.advanceWithoutDelivery(milliseconds);
    for (const waiter of this.#waiters.slice()) {
      if (waiter.due <= this.#elapsed) {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        if (!waiter.signal.aborted) {
          waiter.resolve();
        }
      }
    }
  }

  public advanceWithoutDelivery(milliseconds: number): void {
    this.#elapsed += milliseconds;
    this.#reported += milliseconds;
  }

  public advanceWithoutDeliveryBeforeRead(reads: number, milliseconds: number): void {
    this.#advanceBeforeRead = { milliseconds, reads };
  }

  public activeWaiterCount(): number {
    return this.#waiters.filter(waiter => !waiter.signal.aborted).length;
  }

  public rollback(milliseconds: number): void {
    this.#reported -= milliseconds;
  }
}

export const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await nextTurn();
  }
  assert.fail("timed out waiting for synthetic Claude callback");
};

export const kernelAdapterSnapshot = Object.freeze({
  adapterRevision: binding.adapterRevision,
  binaryRevision: binding.binaryRevision,
  capabilityManifestRevision: binding.capabilityManifestRevision,
  provider: "claude" as const,
});
export const kernelManifest = Object.freeze({
  effectCardinality: "one_coarse_effect_per_operation" as const,
  effectClass: "contained_unmediated_effect" as const,
  manifestRevision: binding.capabilityManifestRevision,
  manifestVersion: 1 as const,
  provider: "claude" as const,
  providerAttemptCardinality: "at_most_one" as const,
  requiredProofKinds: Object.freeze([
    "command_acceptance", "dispatch_authority", "execution_closure", "provider_terminal_observation",
    "output_drain", "host_custody", "workspace_closure", "artifact_manifest_seal",
    "effect_resolution", "containment_execution", "canonical_result_publication", "cutoff_enforcement",
  ] as const),
  resourceScopeRevision: "contained-turn:v1:claude-resource-scope",
  supportedModes: Object.freeze(["analysis", "workspace-write"] as const),
  unknownCapabilityPolicy: "fail_closed" as const,
});
export const kernelAttemptId = containedTurnIdentity("attempt", "attempt:claude-kernel-test");
export const kernelAuthorityVectorDigest = digestContainedTurnCanonicalValue(["kernel-authority"]);
export const kernelCustodyId = containedTurnIdentity("custody", "custody:claude-kernel-test");
export const kernelEffectId = containedTurnIdentity("effect", "effect:claude-kernel-test");
export const kernelOperationId = containedTurnIdentity("operation", "operation:claude-kernel-test");
export const kernelWorkspaceId = containedTurnIdentity("workspace", "workspace:opaque-claude-kernel-test");
export const kernelStartProof = (overrides: Record<string, unknown> = {}) => Object.freeze({
  binding: Object.freeze({
    attemptId: kernelAttemptId,
    authorityVectorDigest: kernelAuthorityVectorDigest,
    custodyId: kernelCustodyId,
    effectId: kernelEffectId,
    hostBootId: containedTurnIdentity("host_boot", "host-boot:claude-kernel-test"),
    hostInstanceId: containedTurnIdentity("host_instance", "host-instance:claude-kernel-test"),
    operationId: kernelOperationId,
    ...overrides,
  }),
  kind: "provider_process_start" as const,
  proofId: containedTurnIdentity("proof", "proof:claude-kernel-start"),
});

export const kernelInput = (
  overrides: Record<string, unknown> = {},
  startOverrides: Record<string, unknown> = {},
) => ({
  adapterSnapshot: kernelAdapterSnapshot,
  attemptId: kernelAttemptId,
  authorityVectorDigest: kernelAuthorityVectorDigest,
  custodyId: kernelCustodyId,
  effectId: kernelEffectId,
  emit: async (_chunk: { readonly cursor: number; readonly kind: "assistant" | "diagnostic" | "progress"; readonly text: string }) => {},
  intent: { mode: "analysis" as const, prompt: "reply exactly OK" },
  isCancellationRequested: async () => false,
  operationId: kernelOperationId,
  providerAccessSnapshot: {
    accessRef: "access:claude-test",
    credentialBindingDigest: "sha256:credential-test",
    credentialBindingRef: "credential:claude-test",
    credentialGeneration: 1,
    ownerAuthorityDigest: "sha256:provider-access-owner",
    projectId: "project:test",
    provider: "claude" as const,
    providerAccountRef: "account:claude-test",
    providerRouteRef: "route:claude-test",
    revision: 1,
    tenantId: "tenant:test",
  },
  start: {
    createProcess: <Process>(create: () => Process): Process => create(),
    observation: Promise.resolve({ kind: "execution_started" as const, proof: kernelStartProof() }),
    ...startOverrides,
  },
  workspaceId: kernelWorkspaceId,
  ...overrides,
});

export const kernelProvider = (
  queryFactory: QueryFactory,
  options: Partial<ConstructorParameters<typeof ClaudeAgentSdkCurrentKernelAdapter>[0]> = {},
) => new ClaudeAgentSdkCurrentKernelAdapter({
  adapterSnapshot: kernelAdapterSnapshot,
  cancellationPollMs: 1,
  executablePath,
  interruptGraceMs: 5,
  manifest: kernelManifest,
  privateExecutions: {
    consume: async (request, consume) => {
      assert.deepEqual(request, {
        attemptId: kernelAttemptId,
        authorityVectorDigest: kernelAuthorityVectorDigest,
        custodyId: kernelCustodyId,
        effectId: kernelEffectId,
        operationId: kernelOperationId,
        workspaceId: kernelWorkspaceId,
      });
      return consume({ privateProjection, workspaceRef });
    },
  },
  processes: { get: () => inertRegistryProcess(), start: () => inertProcess() },
  queryFactory,
  turnTimeoutMs: 100,
  ...options,
});

export const spawnedQuery = (
  messages: readonly unknown[],
  onSpawn?: () => void,
): QueryFactory => queryInput => {
  onSpawn?.();
  queryInput.options.spawnClaudeCodeProcess({
    args: [...claudeAgentSdkArguments("analysis", workspaceRef)],
    command: executablePath,
    cwd: workspaceRef,
    env: { ...privateProjection.environment },
    signal: new AbortController().signal,
  });
  return {
    close: () => {},
    interrupt: async () => {},
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
  };
};
