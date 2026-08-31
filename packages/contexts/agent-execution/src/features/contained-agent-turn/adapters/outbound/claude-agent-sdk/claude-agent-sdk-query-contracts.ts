export interface ClaudeSdkSpawnOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

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
    readonly spawnClaudeCodeProcess: (options: ClaudeSdkSpawnOptions) => unknown;
    readonly strictMcpConfig: true;
    readonly tools: string[];
  };
  readonly prompt: string;
}

export type ClaudeQueryFactory = (input: ClaudeSdkQueryInput) => ClaudeSdkQuery;
