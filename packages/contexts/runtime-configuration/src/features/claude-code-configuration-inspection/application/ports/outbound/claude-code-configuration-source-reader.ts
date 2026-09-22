export interface AuthorizedClaudeCodeConfigurationSource {
  readonly access: "authorized";
  readonly absolutePath: string;
  readonly authorizedFileIdentity?: string;
  readonly canonicalPath: string;
  readonly custodyRoot: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
    readonly rootId: string;
  };
  readonly displayPath: string;
  readonly locationClaims?: readonly string[];
  readonly observationEpoch: string;
  readonly role: "user" | "shared-project" | "project-local";
  readonly selectionBasis:
    | "home-default"
    | "claude-config-dir"
    | "session-primary-working-directory"
    | "repository-root"
    | "main-worktree-root"
    | "legacy-starting-directory"
    | "caller-explicit"
    | "static-preview";
  readonly sourceId: string;
  readonly trust: "user" | "workspace-trusted" | "workspace-untrusted";
}

export type ReadClaudeCodeConfigurationSourceResult =
  | { readonly bytes: Uint8Array; readonly status: "read" }
  | { readonly status: "missing" | "stale" | "too-large" | "unreadable" };

export interface ClaudeCodeConfigurationSourceReader {
  measure?(
    source: AuthorizedClaudeCodeConfigurationSource,
    options?: { readonly signal?: AbortSignal },
  ): Promise<
    | { readonly bytes: number; readonly status: "measured" }
    | { readonly status: "missing" | "stale" | "unreadable" }
  >;
  read(
    source: AuthorizedClaudeCodeConfigurationSource,
    maximumBytes: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadClaudeCodeConfigurationSourceResult>;
}
