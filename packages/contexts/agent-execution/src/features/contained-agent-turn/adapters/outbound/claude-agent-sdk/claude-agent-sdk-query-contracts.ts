type OfficialClaudeQueryFactory = typeof import("@anthropic-ai/claude-agent-sdk")["query"];
type OfficialClaudeQueryInput = Parameters<OfficialClaudeQueryFactory>[0];
type OfficialClaudeQueryOptions = NonNullable<OfficialClaudeQueryInput["options"]>;
type OfficialClaudeSpawnCallback = NonNullable<OfficialClaudeQueryOptions["spawnClaudeCodeProcess"]>;

export type ClaudeSdkSpawnOptions = Parameters<OfficialClaudeSpawnCallback>[0];


export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  close(): void;
  interrupt(): Promise<unknown>;
}

export interface ClaudeSdkQueryInput {
  readonly options: {
    readonly abortController: AbortController;
    readonly allowedTools: string[];
    readonly cwd: string;
    readonly disallowedTools: string[];
    readonly env: Record<string, string | undefined>;
    readonly includePartialMessages: boolean;
    readonly maxTurns: number;
    readonly mcpServers: Record<string, never>;
    readonly pathToClaudeCodeExecutable: string;
    readonly permissionMode: "dontAsk";
    readonly persistSession: false;
    readonly plugins: never[];
    readonly sandbox: {
      readonly allowUnsandboxedCommands: false;
      readonly enabled: true;
      readonly failIfUnavailable: true;
      readonly filesystem: { readonly allowRead: string[]; readonly allowWrite: string[] };
    };
    readonly settingSources: never[];
    readonly spawnClaudeCodeProcess: OfficialClaudeSpawnCallback;
    readonly strictMcpConfig: true;
    readonly tools: string[];
  };
  readonly prompt: string;
}

export type ClaudeQueryFactory = (input: ClaudeSdkQueryInput) => ClaudeSdkQuery;

/**
 * The adapter intentionally exposes a stricter, private subset of the SDK
 * input.  Keep the relation available for declaration tests without making
 * the private subset a public SDK contract.
 */
export type ClaudeSdkOfficialQueryInputAssignability =
  ClaudeSdkQueryInput extends OfficialClaudeQueryInput ? true : false;

export type ClaudeSdkSpawnedProcess = ReturnType<OfficialClaudeSpawnCallback>;
