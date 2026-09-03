import type { Readable, Writable } from "node:stream";

export interface ClaudeSdkSpawnOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly signal: AbortSignal;
}

export interface ClaudeSdkSpawnedProcess {
  readonly exitCode: number | null;
  readonly killed: boolean;
  readonly signalCode?: NodeJS.Signals | null;
  readonly stdin: Writable;
  readonly stdout: Readable;
  kill(signal: NodeJS.Signals): boolean;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export type ClaudeSdkSpawnCallback = (options: ClaudeSdkSpawnOptions) => ClaudeSdkSpawnedProcess;


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
    readonly spawnClaudeCodeProcess: ClaudeSdkSpawnCallback;
    readonly strictMcpConfig: true;
    readonly tools: string[];
  };
  readonly prompt: string;
}

export type ClaudeQueryFactory = (input: ClaudeSdkQueryInput) => ClaudeSdkQuery;
