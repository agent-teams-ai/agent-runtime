import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Limits } from '@agent-teams/provider-session-contracts';
import type { ClaudeToolBinding } from './tool-binding.ts';
export const SDK_REVISION = '0.3.305';
export type ClaudeConfig = {
  sessionRef: string;
  trustedBinding: string;
  cwd: string;
  model: string;
  accountBinding: string;
  configRevision: string;
  environment: Record<string, string>;
  nativeTools: string[];
  autoAllowedTools: string[];
  mcpServers: Record<string, Exclude<McpServerConfig, { type: 'sdk' }>>;
  requiredTools: Record<string, string[]>;
  /** A read-only host handshake; no mutation and no model prompt. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  limits: Limits;
  toolBinding?: ClaudeToolBinding;
  sessionExists: (nativeSession: string) => Promise<boolean>;
  /** Runtime/test Host owns the actual child and must sanitize launch environment. */
  custody: {
    launch: NonNullable<Options['spawnClaudeCodeProcess']>;
    confirmStopped: () => Promise<boolean>;
  };
};
export type Checkpoint = { version: 1; engine: string; nativeSession: string; compatibility: string };
export function compatibility(config: ClaudeConfig): string {
  const { cwd, accountBinding, configRevision, model, trustedBinding, nativeTools, autoAllowedTools, requiredTools } = config;
  return createHash('sha256').update(JSON.stringify({ cwd, accountBinding, configRevision, model, trustedBinding, nativeTools, autoAllowedTools, requiredTools,
    toolBindingTools: config.toolBinding?.matchedToolNames })).digest('hex');
}
export function validConfig(c: ClaudeConfig): boolean {
  return !!(c.sessionRef && c.trustedBinding && c.accountBinding && c.configRevision && c.model && c.cwd.startsWith('/') &&
    nonempty(c.environment.HOME) && nonempty(c.environment.CLAUDE_CONFIG_DIR) && nonempty(c.environment.PATH) &&
    Object.values(c.limits).every((v) => Number.isSafeInteger(v) && v > 0) &&
    !Object.keys(c.environment).some((key) => /^(CLAUDE_CODE_TEAM|CLAUDE_TEAM|CLAUDE_AGENT_TEAMS|CLAUDE_CODE_RESUME|CLAUDE_CODE_CONTINUE)/.test(key)) &&
    !c.nativeTools.some((tool) => /^(Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$)/.test(tool)) &&
    (!c.toolBinding || (c.toolBinding.matchedToolNames.length > 0 && c.toolBinding.matchedToolNames.every((name) => typeof name === 'string' && !!name) && typeof c.toolBinding.prepare === 'function')) &&
    Object.keys(c.requiredTools).every((name) => Object.hasOwn(c.mcpServers, name)));
}
export function options(c: ClaudeConfig, nativeSession: string, restore: boolean): Options {
  return {
    cwd: c.cwd, model: c.model, env: { ...c.environment }, settingSources: [],
    tools: [...c.nativeTools], allowedTools: [...c.autoAllowedTools],
    mcpServers: c.mcpServers, strictMcpConfig: true, permissionMode: 'default',
    persistSession: true, includePartialMessages: true,
    ...(restore ? { resume: nativeSession } : { sessionId: nativeSession }),
    spawnClaudeCodeProcess: (spawnOptions) => c.custody.launch({ ...spawnOptions, env: { ...c.environment } }),
  };
}
export function freshNativeSession(): string { return randomUUID(); }
export function readCheckpoint(value: unknown): Checkpoint | undefined {
  if (value === null || typeof value !== 'object') {return undefined;}
  const cp = value as Record<string, unknown>;
  return cp.version === 1 && typeof cp.engine === 'string' && typeof cp.nativeSession === 'string' &&
    typeof cp.compatibility === 'string' ? { version: 1, engine: cp.engine, nativeSession: cp.nativeSession, compatibility: cp.compatibility } : undefined;
}

/** Pin the caller's private projection once; later caller mutation cannot change a session. */
export function snapshotConfig(c: ClaudeConfig): ClaudeConfig {
  return { ...c, environment: { ...c.environment }, nativeTools: [...c.nativeTools],
    autoAllowedTools: [...c.autoAllowedTools], requiredTools: structuredClone(c.requiredTools),
    mcpServers: structuredClone(c.mcpServers), ...(c.toolBinding ? { toolBinding: { ...c.toolBinding, matchedToolNames: [...c.toolBinding.matchedToolNames] } } : {}), limits: { ...c.limits }, custody: { ...c.custody } };
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
