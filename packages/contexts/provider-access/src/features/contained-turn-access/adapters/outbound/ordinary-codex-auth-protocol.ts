import { timingSafeEqual } from 'node:crypto';
import { authRecord } from './ordinary-codex-auth-json.js';
import { AUTH_DISABLED_FEATURES, ORDINARY_CODEX_AUTH_MODEL, OrdinaryCodexAuthRefused, type OrdinaryCodexAuthReason } from './ordinary-codex-auth-contracts.js';

export type AuthMethod = 'initialize' | 'config/read' | 'account/read' | 'getAuthStatus' | 'account/rateLimits/read' | 'model/list';
export interface AuthRpc {
  request(method: AuthMethod, params: object): Promise<Record<string, unknown>>;
  initialized(): void;
}
export interface CapturedAuthBytes { readonly token: Buffer; readonly accountId: Buffer; }
function refuse(reason: OrdinaryCodexAuthReason = 'validation'): never { throw new OrdinaryCodexAuthRefused(reason); }
const absent = (value: unknown) => value === null || value === undefined;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
  if (value && typeof value === 'object') {
    const record = authRecord(value);
    return '{' + Object.keys(record).toSorted().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  return JSON.stringify(value);
};
const copyAscii = (value: unknown, max: number): Buffer => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !/^[\x21-\x7e]+$/.test(value)) { return refuse(); }
  const bytes = Buffer.alloc(value.length); bytes.write(value, 'ascii'); return bytes;
};
function account(value: Record<string, unknown>): Buffer {
  if (value.requiresOpenaiAuth !== true || authRecord(value.account).type !== 'chatgpt') { return refuse(); }
  const text = canonical(value.account);
  if (text.length > 8192) { return refuse(); }
  const bytes = Buffer.alloc(Buffer.byteLength(text)); bytes.write(text); return bytes;
}
function token(value: Record<string, unknown>): Buffer {
  if (value.authMethod !== 'chatgpt' || value.requiresOpenaiAuth !== true) { return refuse(); }
  try { return copyAscii(value.authToken, 4096); } finally { value.authToken = null; }
}

/** Private config origin is checked, not merely the requested model. */
export function verifyAuthConfig(result: Record<string, unknown>, home: string, source: string): void {
  const config = authRecord(result.config);
  const text = JSON.stringify(result);
  if (text.includes(source) || config.model !== ORDINARY_CODEX_AUTH_MODEL ||
      config.cli_auth_credentials_store !== 'file' || config.project_doc_max_bytes !== 0 ||
      config.allow_login_shell !== false || config.web_search !== 'disabled' ||
      !absent(config.model_catalog_json) || config.mcp_servers && Object.keys(authRecord(config.mcp_servers)).length > 0) { refuse('config_policy'); }
  const features = authRecord(config.features);
  if (AUTH_DISABLED_FEATURES.some(feature => features[feature] !== false)) { refuse('config_features'); }
  if (config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/') { refuse('config_endpoint'); }
  const origins = authRecord(result.origins);
  const origin = authRecord(authRecord(origins.model).name);
  if (origin.type !== 'user' || origin.file !== home + '/config.toml') { refuse('config_origin'); }
  verifyLayers(result.layers, home);
}

function verifyLayers(layers: unknown, home: string): void {
  if (!Array.isArray(layers) || layers.length > 16) { refuse('config_layers'); }
  let user = false;
  for (const raw of layers) {
    const layer = authRecord(raw), name = authRecord(layer.name);
    if (name.type === 'user') {
      if (user || name.file !== home + '/config.toml' || !absent(layer.disabledReason)) { refuse('config_layers'); }
      user = true;
    } else if (name.type !== 'sessionFlags' && name.type !== 'system' && name.type !== 'mdm') { refuse('config_layers'); }
    // Global/managed config must not contribute an active file; defaults have no config keys.
    if ((name.type === 'system' || name.type === 'mdm') && absent(layer.disabledReason) && Object.keys(authRecord(layer.config)).length > 0) { refuse('config_layers'); }
  }
  if (!user) { refuse('config_layers'); }
}

export async function readOfficialAuth(rpc: AuthRpc, home: string, source: string): Promise<CapturedAuthBytes> {
  const buffers: Buffer[] = [];
  let result: CapturedAuthBytes | undefined;
  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent-runtime-pa-auth', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.initialized();
    verifyAuthConfig(await rpc.request('config/read', { cwd: home, includeLayers: true }), home, source);
    const before = account(await rpc.request('account/read', { refreshToken: false })); buffers.push(before);
    const first = token(await rpc.request('getAuthStatus', { includeToken: true, refreshToken: false })); buffers.push(first);
    const limits = await rpc.request('account/rateLimits/read', {});
    // Existing PA admission is stricter (256) than the ordinary upper bound (512).
    const accountId = copyAscii(limits.accountId, 256); buffers.push(accountId); limits.accountId = null;
    await verifyModelAvailability(rpc);
    const second = token(await rpc.request('getAuthStatus', { includeToken: true, refreshToken: false })); buffers.push(second);
    const after = account(await rpc.request('account/read', { refreshToken: false })); buffers.push(after);
    if (first.length !== second.length || !timingSafeEqual(first, second) || before.length !== after.length || !timingSafeEqual(before, after)) { refuse('identity_drift'); }
    result = { token: first, accountId }; return result;
  } finally {
    for (const bytes of buffers) { if (bytes !== result?.token && bytes !== result?.accountId) { bytes.fill(0); } }
  }
}

async function verifyModelAvailability(rpc: AuthRpc): Promise<void> {
    const cursors = new Set<string>(); let cursor: string | null = null, observed = false, complete = false;
    for (let page = 0; page < 4; page += 1) {
      const models = await rpc.request('model/list', { cursor, limit: 100, includeHidden: true });
      if (!Array.isArray(models.data) || models.data.length > 100) { refuse(); }
      for (const raw of models.data) {
        const model = authRecord(raw);
        if (model.id === ORDINARY_CODEX_AUTH_MODEL || model.model === ORDINARY_CODEX_AUTH_MODEL) { observed = true; }
      }
      if (models.nextCursor === null) { complete = true; break; }
      if (typeof models.nextCursor !== 'string' || models.nextCursor.length < 1 || models.nextCursor.length > 512 || cursors.has(models.nextCursor)) { refuse('model_pagination'); }
      cursor = models.nextCursor; cursors.add(cursor);
    }
    if (!complete) { refuse('model_pagination'); }
    if (!observed) { refuse('model_unavailable'); }
}
