import { acquisitionFixture } from './operation-credential-material-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readOfficialAuth, verifyAuthConfig, type AuthMethod } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-protocol.js';
import { parseAuthFrame, conservativeTokenExpiry } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-json.js';
import { captureAuthHelper } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-ipc.js';
import { createOrdinaryCodexAuthCapture } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-capture.js';
import { AUTH_DISABLED_FEATURES, OrdinaryCodexAuthRefused } from '../../../dist/features/contained-turn-access/adapters/outbound/ordinary-codex-auth-contracts.js';

const home = '/synthetic/private', source = '/synthetic/source', model = 'gpt-5.3-codex-spark';
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) => 'synthetic.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.unsigned';
const config = () => ({ config: { features: Object.fromEntries(AUTH_DISABLED_FEATURES.map(key => [key, false])), chatgpt_base_url: 'https://chatgpt.com/backend-api/', model, cli_auth_credentials_store: 'file', project_doc_max_bytes: 0, allow_login_shell: false, web_search: 'disabled' },
  origins: { model: { name: { type: 'user', file: home + '/config.toml' } } },
  layers: [{ name: { type: 'user', file: home + '/config.toml' }, config: { model } }] });
function fixture(change: (method: AuthMethod, result: Record<string, unknown>, count: number) => Record<string, unknown> = (_m, r) => r) {
  const methods: string[] = [], counts = new Map<string, number>(), token = jwt();
  return { methods, rpc: {
    initialized() { methods.push('initialized'); },
    async request(method: AuthMethod) {
      methods.push(method); const count = (counts.get(method) ?? 0) + 1; counts.set(method, count);
      const result: Record<string, unknown> = method === 'initialize' ? {} : method === 'config/read' ? config() :
        method === 'account/read' ? { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'synthetic@example.invalid' } } :
        method === 'getAuthStatus' ? { authMethod: 'chatgpt', requiresOpenaiAuth: true, authToken: token } :
        method === 'account/rateLimits/read' ? { accountId: 'synthetic-account' } : { data: [{ id: model }], nextCursor: null };
      return change(method, result, count);
    },
  } };
}
test('official auth uses bounded reads, stable account/token and independently observed Spark', async () => {
  const f = fixture(); const material = await readOfficialAuth(f.rpc, home, source);
  assert.equal(material.accountId.toString(), 'synthetic-account');
  assert.ok(material.token.length < 4096);
  assert.deepEqual(f.methods, ['initialize', 'initialized', 'config/read', 'account/read', 'getAuthStatus', 'account/rateLimits/read', 'model/list', 'getAuthStatus', 'account/read']);
  material.token.fill(0); material.accountId.fill(0);
});
for (const [label, mutate] of [
  ['token drift', (m: AuthMethod, r: Record<string, unknown>, n: number) => m === 'getAuthStatus' && n === 2 ? { ...r, authToken: 'changed' } : r],
  ['account drift', (m: AuthMethod, r: Record<string, unknown>, n: number) => m === 'account/read' && n === 2 ? { ...r, account: { type: 'chatgpt', email: 'other' } } : r],
  ['oversize token', (m: AuthMethod, r: Record<string, unknown>) => m === 'getAuthStatus' ? { ...r, authToken: 'x'.repeat(4097) } : r],
  ['oversize account', (m: AuthMethod, r: Record<string, unknown>) => m === 'account/rateLimits/read' ? { accountId: 'a'.repeat(513) } : r],
  ['missing backend account', (m: AuthMethod, r: Record<string, unknown>) => m === 'account/rateLimits/read' ? {} : r],
  ['Spark absent', (m: AuthMethod, r: Record<string, unknown>) => m === 'model/list' ? { data: [{ id: 'gpt-5.4' }], nextCursor: null } : r],
  ['cursor cycle', (m: AuthMethod, r: Record<string, unknown>) => m === 'model/list' ? { data: [{ id: model }], nextCursor: 'again' } : r],
] as const) {
  test(`auth capture rejects ${label}`, async () => { await assert.rejects(readOfficialAuth(fixture(mutate).rpc, home, source), OrdinaryCodexAuthRefused); });
}
test('private config origin, no source config and no catalog override are enforced', () => {
  verifyAuthConfig(config(), home, source);
  const bad = config(); bad.origins.model.name.file = source + '/config.toml';
  assert.throws(() => verifyAuthConfig(bad, home, source));
  assert.throws(() => verifyAuthConfig({ ...config(), config: { ...config().config, model_catalog_json: '/invented/models.json' } }, home, source));
});
test('strict JSON rejects escaped duplicate keys, invalid UTF8 and excessive depth', () => {
  assert.throws(() => parseAuthFrame(Buffer.from('{"id":1,"\\u0069d":2}')));
  assert.throws(() => parseAuthFrame(Buffer.from([0xff])));
  assert.throws(() => parseAuthFrame(Buffer.from('{"a":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}')));
});
test('JWT supplies only conservative expiry and unknown/expired expiry is refused', () => {
  const now = Date.now(); assert.ok(conservativeTokenExpiry(Buffer.from(jwt()), now) <= now + 60_000);
  assert.throws(() => conservativeTokenExpiry(Buffer.from(jwt(1)), now));
  assert.throws(() => conservativeTokenExpiry(Buffer.from('opaque'), now));
});
const helperScript = `
const readline = require('node:readline');
const home = ${JSON.stringify(home)}, model = ${JSON.stringify(model)};
const token = 'synthetic.' + Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url') + '.unsigned';
readline.createInterface({input:process.stdin}).on('line', line => {
 const q=JSON.parse(line); if(q.method==='initialized') return;
 let result={};
 if(q.method==='config/read') result=${JSON.stringify(config())};
 if(q.method==='account/read') result={requiresOpenaiAuth:true,account:{type:'chatgpt',email:'fixture'}};
 if(q.method==='getAuthStatus') result={authMethod:'chatgpt',requiresOpenaiAuth:true,authToken:token};
 if(q.method==='account/rateLimits/read') result={accountId:'synthetic-account'};
 if(q.method==='model/list') result={data:[{id:model}],nextCursor:null};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
});
`;
test('synthetic helper returns material only after actual exit, stdio closure and owned group disappearance', async () => {
  const child = spawn(process.execPath, ['-e', helperScript], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const observations: unknown[] = [];
  const material = await captureAuthHelper({ child, signal: new AbortController().signal, deadline: performance.now() + 5000,
    home, source, captureRef: 'synthetic', record: value => { observations.push(value); } });
  assert.equal(material.accountId.toString(), 'synthetic-account');
  assert.deepEqual(observations.at(-1), { captureRef: 'synthetic', outcome: 'closed', exitObserved: true, closeObserved: true, processGroupGone: true });
  assert.equal(child.listenerCount('exit'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
  material.token.fill(0); material.accountId.fill(0);
});
test('record failure kills and closes synthetic helper without returning material', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  await assert.rejects(captureAuthHelper({ child, signal: new AbortController().signal, deadline: performance.now() + 2500,
    home, source, captureRef: 'synthetic-refusal', record: () => { throw new Error('sink unavailable'); } }), OrdinaryCodexAuthRefused);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});
test('capture has synchronous disposal and settles without touching files before capture', async () => {
  const owner = createOrdinaryCodexAuthCapture({ operationRef: 'synthetic', executable: '/never-open', sourceDirectory: '/never-read', privateRoot: '/never-write',
    generation: 1, signal: new AbortController().signal, deadline: performance.now() + 1000, record: () => {} });
  owner.dispose(); await owner.settled;
  await assert.rejects(owner.capture(), OrdinaryCodexAuthRefused);
});

test('abort while RPC is pending closes the owned child and leaks no diagnostic payload', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stderr.write("invented-secret");setInterval(()=>{},1000)'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const controller = new AbortController(), observations: unknown[] = [];
  const timer = setTimeout(() => controller.abort(), 40);
  try {
    await assert.rejects(captureAuthHelper({ child, signal: controller.signal, deadline: performance.now() + 2500,
      home, source, captureRef: 'synthetic-abort', record: value => { observations.push(value); } }), OrdinaryCodexAuthRefused);
    assert.ok(!JSON.stringify(observations).includes('invented-secret'));
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.stdout.listenerCount('data'), 0);
  } finally { clearTimeout(timer); }
});
for (const [label, script] of [
  ['duplicate response key', 'process.stdout.write(\'{"id":1,"id":1,"result":{}}\\n\');setInterval(()=>{},1000)'],
  ['oversize frame', 'process.stdout.write("x".repeat(65537));setInterval(()=>{},1000)'],
  ['aggregate stderr quota', 'process.stderr.write("x".repeat(262145));setInterval(()=>{},1000)'],
] as const) {
  test(`IPC rejects ${label} and releases its listeners`, async () => {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    await assert.rejects(captureAuthHelper({ child, signal: new AbortController().signal, deadline: performance.now() + 2500,
      home, source, captureRef: 'synthetic-malformed', record: () => {} }), OrdinaryCodexAuthRefused);
    assert.equal(child.listenerCount('exit'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
  });
}
test('enabled extension feature and an overridden official endpoint fail config verification', () => {
  const enabled = config(); enabled.config.features.plugins = true;
  assert.throws(() => verifyAuthConfig(enabled, home, source));
  const redirected = config(); redirected.config.chatgpt_base_url = 'https://example.invalid/';
  assert.throws(() => verifyAuthConfig(redirected, home, source));
});


test('dedicated official capture buffers transfer to existing PA admission without retained producer aliases', async t => {
  const owner = acquisitionFixture(); t.after(() => owner.owner.dispose());
  const captured = await readOfficialAuth(fixture().rpc, home, source);
  const outcome = owner.source.admission.admit({ operationRef: owner.selection.operationRef,
    recipe: owner.selection.recipe, binding: owner.selection.binding,
    fields: [{ name: 'token', valueBytes: captured.token }, { name: 'accountId', valueBytes: captured.accountId }] });
  assert.equal(outcome.kind, 'admitted');
  assert.equal(captured.token.byteLength, 0);
  assert.equal(captured.accountId.byteLength, 0);
});
