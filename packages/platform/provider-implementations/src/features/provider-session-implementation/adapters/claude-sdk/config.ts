import { createHash, randomUUID } from 'node:crypto';
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Limits } from '@agent-teams/provider-session-contracts';
import type { ClaudeToolBinding } from './tool-binding.ts';
import { attachmentCompatibility, snapshotAttachmentPort } from '../provider-session-io/attachments.ts';
import type { AttachmentPort } from '../provider-session-io/attachments.ts';
export const SDK_REVISION = '0.3.305';
export type ClaudeConfig = {
  sessionRef: string;
  trustedBinding: string;
  cwd: string;
  model: string;
  accountBinding: string;
  configRevision: string;
  environment: Record<string, string>;
  attachments?: AttachmentPort;
  /** Omission preserves the existing explicit custom-directory requirement. */
  configNamespace?: 'native-default' | 'custom-directory';
  /** Trusted, selected native configuration. No arbitrary SDK options, settings or hooks. */
  nativeOptions?: {
    permissionMode?: NonNullable<Options['permissionMode']>;
    allowDangerouslySkipPermissions?: boolean;
    settingSources?: NonNullable<Options['settingSources']>;
    projectInstructions?: { append?: string };
    effort?: NonNullable<Options['effort']>;
    fastMode?: boolean;
    /** model-default preserves the Host-selected model, including its [1m] suffix. */
    context?: 'model-default' | 'one-million';
  };
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
    toolBindingTools: config.toolBinding?.matchedToolNames,
    ...(config.attachments ? { attachments: attachmentCompatibility(config.attachments) } : {}),
    ...(config.nativeOptions ? { nativeOptions: selectedOptions(config) } : {}),
    ...(config.configNamespace ? { configNamespace: config.configNamespace, home: config.environment.HOME,
      configDirectory: config.environment.CLAUDE_CONFIG_DIR } : {}) })).digest('hex');
}
export function validConfig(c: ClaudeConfig): boolean {
  return !!(c.sessionRef && c.trustedBinding && c.accountBinding && c.configRevision && c.model && c.cwd.startsWith('/') &&
    nonempty(c.environment.HOME) && nonempty(c.environment.PATH) &&
    validNamespace(c) &&
    validNativeOptions(c.nativeOptions) &&
    Object.values(c.limits).every((v) => Number.isSafeInteger(v) && v > 0) &&
    !Object.keys(c.environment).some((key) => /^(CLAUDE_CODE_TEAM|CLAUDE_TEAM|CLAUDE_AGENT_TEAMS|CLAUDE_CODE_RESUME|CLAUDE_CODE_CONTINUE)/.test(key)) &&
    !c.nativeTools.some((tool) => /^(Team|Task|TodoWrite|Agent|Cron|Schedule|SendMessage$|ListAgents$)/.test(tool)) &&
    (!c.toolBinding || (c.toolBinding.matchedToolNames.length > 0 && c.toolBinding.matchedToolNames.every((name) => typeof name === 'string' && !!name) && typeof c.toolBinding.prepare === 'function')) &&
    Object.keys(c.requiredTools).every((name) => Object.hasOwn(c.mcpServers, name)));
}
export function options(c: ClaudeConfig, nativeSession: string, restore: boolean): Options {
  return {
    cwd: c.cwd, model: c.model, env: { ...c.environment }, ...selectedOptions(c),
    tools: [...c.nativeTools], allowedTools: [...c.autoAllowedTools],
    mcpServers: c.mcpServers, strictMcpConfig: true,
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
    ...(c.attachments !== undefined ? { attachments: snapshotAttachmentPort(c.attachments)! } : {}),
    ...(c.nativeOptions ? { nativeOptions: structuredClone(c.nativeOptions) } : {}),
    autoAllowedTools: [...c.autoAllowedTools], requiredTools: structuredClone(c.requiredTools),
    mcpServers: structuredClone(c.mcpServers), ...(c.toolBinding ? { toolBinding: { ...c.toolBinding, matchedToolNames: [...c.toolBinding.matchedToolNames] } } : {}), limits: { ...c.limits }, custody: { ...c.custody } };
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validNamespace(c: ClaudeConfig): boolean {
  return c.configNamespace === 'native-default' ? !Object.hasOwn(c.environment, 'CLAUDE_CONFIG_DIR') :
    (c.configNamespace === undefined || c.configNamespace === 'custom-directory') && nonempty(c.environment.CLAUDE_CONFIG_DIR);
}

function selectedOptions(c: ClaudeConfig): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions' | 'settingSources' | 'systemPrompt' | 'effort' | 'settings' | 'betas'> {
  const n = c.nativeOptions;
  return { permissionMode: n?.permissionMode ?? 'default', settingSources: [...(n?.settingSources ?? [])],
    ...(n?.allowDangerouslySkipPermissions !== undefined ? { allowDangerouslySkipPermissions: n.allowDangerouslySkipPermissions } : {}),
    ...(n?.projectInstructions ? { systemPrompt: { type: 'preset', preset: 'claude_code', ...(n.projectInstructions.append !== undefined ? { append: n.projectInstructions.append } : {}) } } : {}),
    ...(n?.effort !== undefined ? { effort: n.effort } : {}),
    ...(n?.fastMode !== undefined ? { settings: { fastMode: n.fastMode } } : {}),
    ...(n?.context === 'one-million' ? { betas: ['context-1m-2025-08-07'] } : {}),
  };
}

function validNativeOptions(n: ClaudeConfig['nativeOptions']): boolean {
  if (n === undefined) { return true; }
  if (!n || typeof n !== 'object' || Array.isArray(n) || Object.keys(n).some(key => !['permissionMode', 'allowDangerouslySkipPermissions', 'settingSources', 'projectInstructions', 'effort', 'fastMode', 'context'].includes(key))) { return false; }
  return validPermissionOptions(n) &&
    (n.settingSources === undefined || (Array.isArray(n.settingSources) && n.settingSources.every(source => ['user', 'project', 'local'].includes(source)))) &&
    validInstructions(n.projectInstructions) &&
    (n.effort === undefined || ['low', 'medium', 'high', 'xhigh', 'max'].includes(n.effort)) &&
    (n.fastMode === undefined || typeof n.fastMode === 'boolean') &&
    (n.context === undefined || ['model-default', 'one-million'].includes(n.context));
}

function validPermissionOptions(n: NonNullable<ClaudeConfig['nativeOptions']>): boolean {
  return (n.permissionMode === undefined || ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(n.permissionMode)) &&
    (n.allowDangerouslySkipPermissions === undefined || typeof n.allowDangerouslySkipPermissions === 'boolean') &&
    (n.permissionMode !== 'bypassPermissions' || n.allowDangerouslySkipPermissions === true);
}
function validInstructions(value: NonNullable<ClaudeConfig['nativeOptions']>['projectInstructions']): boolean {
  return value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => key === 'append') && (value.append === undefined || typeof value.append === 'string'));
}
