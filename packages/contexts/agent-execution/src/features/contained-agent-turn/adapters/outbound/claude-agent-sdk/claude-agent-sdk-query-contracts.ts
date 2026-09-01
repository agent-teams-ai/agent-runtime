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
    readonly env: Readonly<Record<string, string>>;
    readonly includePartialMessages: boolean;
    readonly maxTurns: number;
    readonly mcpServers: Record<string, never>;
    readonly pathToClaudeCodeExecutable: string;
    readonly permissionMode: "dontAsk";
    readonly persistSession: false;
    readonly plugins: readonly never[];
    readonly sandbox: {
      readonly allowUnsandboxedCommands: false;
      readonly enabled: true;
      readonly failIfUnavailable: true;
      readonly filesystem: { readonly allowRead: string[]; readonly allowWrite: string[] };
    };
    readonly settingSources: readonly never[];
    readonly spawnClaudeCodeProcess: OfficialClaudeSpawnCallback;
    readonly strictMcpConfig: true;
    readonly tools: string[];
  };
  readonly prompt: string;
}

export type ClaudeQueryFactory = (input: ClaudeSdkQueryInput) => ClaudeSdkQuery;

type AssertAssignable<Value extends true> = Value;
export type ClaudeSdkOfficialQueryInputAssignability = AssertAssignable<
  ClaudeSdkQueryInput extends OfficialClaudeQueryInput ? true : false
>;
