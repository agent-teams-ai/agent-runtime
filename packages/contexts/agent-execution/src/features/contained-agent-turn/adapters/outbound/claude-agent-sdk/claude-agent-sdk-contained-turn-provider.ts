import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ContainedTurnAdapterCapabilityManifest,
  ContainedTurnProviderExecutionOutcome,
  ContainedTurnProviderPort,
  CustodiedProviderProcessRegistry,
  CustodiedSdkProcessLauncher,
} from "../provider-delegation-ports/contained-turn-provider-delegation-port.js";
import type {
  PrivateDirectoryCustodyPort,
} from "../provider-delegation-ports/private-directory-custody-port.js";
import {
  claudeAgentSdkTools,
  type ClaudeAgentSdkPrivateProjection,
  type ClaudeAgentSdkPrivateProjectionResolver,
} from "./claude-agent-sdk-launch-plan.js";
import {
  claudeNotAccepted,
  ClaudeAgentSdkTurnExecution,
  type ClaudeAgentSdkControlClock,
} from "./claude-agent-sdk-turn-execution.js";
import type {
  ClaudeQueryFactory,
  ClaudeSdkQueryInput,
} from "./claude-agent-sdk-query-contracts.js";
import { captureClaudePrivateDirectoryCustody } from "./claude-private-directory-custody.js";

const DEFAULT_CANCELLATION_POLL_MS = 100;
const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 1_200_000;
export type { ClaudeAgentSdkControlClock } from "./claude-agent-sdk-turn-execution.js";

const defaultClock: ClaudeAgentSdkControlClock = Object.freeze({
  now: () => performance.now(),
  async wait(milliseconds: number, signal: AbortSignal) {
    await delay(milliseconds, undefined, { signal });
  },
});

const loadClaudeQueryFactory = async (): Promise<ClaudeQueryFactory> => {
  const loaded: unknown = await import("@anthropic-ai/claude-agent-sdk");
  if (typeof loaded !== "object" || loaded === null || !("query" in loaded) || typeof loaded.query !== "function") {
    throw new Error("Claude Agent SDK query export is unavailable");
  }
  return loaded.query as ClaudeQueryFactory;
};

export interface ClaudeAgentSdkContainedTurnProviderOptions {
  readonly cancellationPollMs?: number;
  readonly clock?: ClaudeAgentSdkControlClock;
  readonly executablePath: string;
  readonly interruptGraceMs?: number;
  readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly privateProjections: ClaudeAgentSdkPrivateProjectionResolver;
  readonly privateDirectoryCustody: PrivateDirectoryCustodyPort;
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory?: ClaudeQueryFactory;
  readonly turnTimeoutMs?: number;
}

interface ProviderSnapshot {
  readonly cancellationPollMs: number;
  readonly clock: ClaudeAgentSdkControlClock;
  readonly executablePath: string;
  readonly interruptGraceMs: number;
  readonly privateProjections: ClaudeAgentSdkPrivateProjectionResolver;
  readonly privateDirectoryCustody: PrivateDirectoryCustodyPort;
  readonly processes: CustodiedProviderProcessRegistry & CustodiedSdkProcessLauncher;
  readonly queryFactory: ClaudeQueryFactory | undefined;
  readonly turnTimeoutMs: number;
}

const positiveInteger = (name: string, value: number | undefined, fallback: number): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return selected;
};

const disallowedTools = (mode: "analysis" | "workspace-write"): readonly string[] =>
  mode === "analysis"
    ? ["Task", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]
    : ["Task", "Bash", "NotebookEdit", "WebFetch", "WebSearch"];

const sdkSandbox = (
  mode: "analysis" | "workspace-write",
  workspaceRef: string,
): ClaudeSdkQueryInput["options"]["sandbox"] => ({
  allowUnsandboxedCommands: false,
  enabled: true,
  failIfUnavailable: true,
  filesystem: {
    allowRead: [workspaceRef],
    allowWrite: mode === "analysis" ? [] : [workspaceRef],
  },
});

export class ClaudeAgentSdkContainedTurnProvider implements ContainedTurnProviderPort {
  public readonly manifest: ContainedTurnAdapterCapabilityManifest;
  readonly #snapshot: ProviderSnapshot;

  public constructor(options: ClaudeAgentSdkContainedTurnProviderOptions) {
    if (options.manifest.providerBinding.provider !== "claude") {
      throw new Error("Claude Agent SDK adapter requires a Claude provider binding");
    }
    this.manifest = Object.freeze({
      effectClass: options.manifest.effectClass,
      providerBinding: Object.freeze({ ...options.manifest.providerBinding }),
      supportedModes: Object.freeze([...options.manifest.supportedModes]),
    });
    this.#snapshot = Object.freeze({
      cancellationPollMs: positiveInteger(
        "cancellationPollMs",
        options.cancellationPollMs,
        DEFAULT_CANCELLATION_POLL_MS,
      ),
      clock: options.clock ?? defaultClock,
      executablePath: options.executablePath,
      interruptGraceMs: positiveInteger(
        "interruptGraceMs",
        options.interruptGraceMs,
        DEFAULT_INTERRUPT_GRACE_MS,
      ),
      privateProjections: options.privateProjections,
      privateDirectoryCustody: captureClaudePrivateDirectoryCustody(options.privateDirectoryCustody),
      processes: options.processes,
      queryFactory: options.queryFactory,
      turnTimeoutMs: positiveInteger("turnTimeoutMs", options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS),
    });
  }

  public async execute(
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  ): Promise<ContainedTurnProviderExecutionOutcome> {
    if (!this.manifest.supportedModes.includes(input.intent.mode)) {
      return claudeNotAccepted(input, "mode-unsupported");
    }
    const execution = new ClaudeAgentSdkTurnExecution({
      adapterRevision: this.manifest.providerBinding.adapterRevision,
      binaryRevision: this.manifest.providerBinding.binaryRevision,
      cancellationPollMs: this.#snapshot.cancellationPollMs,
      clock: this.#snapshot.clock,
      input,
      interruptGraceMs: this.#snapshot.interruptGraceMs,
      privateDirectoryCustody: this.#snapshot.privateDirectoryCustody,
      turnTimeoutMs: this.#snapshot.turnTimeoutMs,
    });
    return execution.run({
      loadQueryFactory: () => this.#snapshot.queryFactory ?? loadClaudeQueryFactory(),
      resolveProjection: () => this.#snapshot.privateProjections.resolve({
        custodyRef: input.custody.custodyRef,
        workspaceRef: input.workspaceRef,
      }),
      startQuery: (factory, abortController, projection) => this.#startQuery(
        factory,
        abortController,
        projection,
        input,
      ),
    });
  }

  #startQuery(
    factory: ClaudeQueryFactory,
    abortController: AbortController,
    projection: ClaudeAgentSdkPrivateProjection,
    input: Parameters<ContainedTurnProviderPort["execute"]>[0],
  ) {
    const tools = [...claudeAgentSdkTools(input.intent.mode)];
    return factory({
      prompt: input.intent.prompt,
      options: {
        abortController,
        allowedTools: tools,
        cwd: input.workspaceRef,
        disallowedTools: [...disallowedTools(input.intent.mode)],
        env: projection.environment,
        includePartialMessages: true,
        maxTurns: 1,
        mcpServers: {},
        pathToClaudeCodeExecutable: this.#snapshot.executablePath,
        permissionMode: "dontAsk",
        persistSession: false,
        plugins: [],
        sandbox: sdkSandbox(input.intent.mode, input.workspaceRef),
        settingSources: [],
        spawnClaudeCodeProcess: options => this.#snapshot.processes.start(input.custody.custodyRef, {
          arguments: options.args,
          command: options.command,
          cwd: options.cwd,
          environment: options.env,
          signal: options.signal,
        }),
        strictMcpConfig: true,
        tools,
      },
    });
  }
}
