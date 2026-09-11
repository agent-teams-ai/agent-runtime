import {test} from 'node:test';
import assert from 'node:assert/strict';
import cp, {spawn} from 'node:child_process';
import fs, {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {capturePrivate} from './auth-ipc.ts';
import {createPrivateOfficialAuthOwner,BINARY_SHA256} from './owner.ts';
import {createPostgresCredentialRenderingOwner} from '../../../../../contexts/provider-access/dist/features/contained-turn-access/composition/postgres-credential-rendering-owner.js';
async function peer(t, scenario) {
  const cwd = await mkdtemp(join(tmpdir(), 'e411-invented-peer-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  return spawn(process.execPath, [fileURLToPath(new URL('./synthetic-child.mjs', import.meta.url)), scenario], {cwd, env:{}, stdio:['pipe','pipe','pipe']});
}
for (const scenario of ['wrongmode','modechanged','external','nullaccount','missingaccount','totalbuffer','tokenchange','oversize','parser','duplicatekey','rawerror','badexit','hang']) {
  test(`synthetic refusal ${scenario}: sanitized and closed`, async t => {
    const child = await peer(t, scenario);
    await assert.rejects(capturePrivate(child, new AbortController().signal, performance.now()+ (scenario === 'hang' ? 100 : 2000)), e => e.message === 'PRIVATE_AUTH_REFUSED' && !String(e.stack).includes('invented-secret'));
    assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(child.stdout.destroyed, true);
  });
}
test('synthetic cancellation closes child before rejection', async t => {
  const child = await peer(t,'hang'); const control = new AbortController();
  const result = capturePrivate(child,control.signal,performance.now()+2000); setTimeout(()=>control.abort(),50);
  await assert.rejects(result,/PRIVATE_AUTH_REFUSED/); assert.ok(child.signalCode);
});
test('synthetic success waits for exit; existing Postgres PA owner accepts exclusive buffers without DB I/O', async t => {
  const child = await peer(t,'exitdelay'); const control = new AbortController(); const deadline = performance.now()+2000;
  const start = performance.now(); const material = await capturePrivate(child,control.signal,deadline);
  assert.equal(child.exitCode,0); assert.ok(performance.now()-start >= 120);
  assert.equal(material.token.toString(),'invented-secret');
  const binding = {tenantId:'synthetic-tenant',projectId:'synthetic-project',scopeDigest:'synthetic-scope',provider:'codex',providerAccountRef:'invented-account',
    credentialGeneration:1,bindingRevision:1,availability:'available',revocation:'active',accessRef:'synthetic-access',credentialBindingRef:'synthetic-binding',providerRouteRef:'synthetic-route',credentialBindingDigest:'synthetic-digest'};
  const selection = {binding,operationRef:'synthetic-operation',recipe:'codex-chatgpt',operationAbortSignal:control.signal,deadline};
  // Clearly fake infrastructure: admission must be local and perform zero connection calls.
  let connects = 0; const owner = createPostgresCredentialRenderingOwner({connect:async()=>{connects++;throw new Error('synthetic DB not connected');}},selection);
  t.after(()=>owner.owner.dispose());
  const seed = {operationRef:selection.operationRef, binding, recipe:selection.recipe,fields:[{name:'token',valueBytes:material.token},{name:'accountId',valueBytes:material.accountId}]};
  assert.equal(owner.control.materialAdmission.admit(seed).kind,'admitted');
  assert.equal(material.token.byteLength,0); assert.equal(material.accountId.byteLength,0);
  assert.equal(owner.control.materialAdmission.admit(seed).kind,'rejected'); assert.equal(connects,0);
});
test('private official owner is opaque and one-shot even on preflight refusal; no binary launched', async () => {
  const signal = new AbortController().signal;
  const owner = createPrivateOfficialAuthOwner({operationRef:'invented-operation',executable:'/nonexistent',codexHome:'/nonexistent',sandbox:'/nonexistent',generation:1,readGeneration:()=>2,signal,deadline:performance.now()+1000});
  assert.equal(JSON.stringify(owner),'{}'); await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/);
  await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/); owner.dispose();
});

// Explicitly fake pin/filesystem/process infrastructure, limited to these synthetic tests.
// Production entrypoint has no alternate binary pin or injectable process factory.
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
async function fakeOfficial(t, scenario, run) {
  const child = await peer(t,scenario);
  t.mock.method(fs,'realpath',async path=>path);
  t.mock.method(fs,'lstat',async()=>({isDirectory:()=>true,uid:process.getuid(),mode:0o700}));
  t.mock.method(fs,'open',async()=>({stat:async()=>({isFile:()=>true,mode:0o700}),close:async()=>{},
    createReadStream:()=>({async *[Symbol.asyncIterator](){yield Buffer.from('invented binary bytes');}})}));
  const realHash=crypto.createHash; let hashCalls=0;
  t.mock.method(crypto,'createHash',(...args)=>++hashCalls===1?({update(){return this;},digest:()=>BINARY_SHA256}):realHash(...args));
  let launches=0;
  t.mock.method(cp,'spawn',(exe,args,options)=>{
    launches++; assert.deepEqual(args,['app-server','--strict-config','-c','default_permissions="agent-runtime-contained-v1"','--listen','stdio://']);
    assert.equal(options.cwd,'/invented-sandbox'); assert.equal(options.env.CODEX_HOME,'/invented-home');
    assert.ok(!JSON.stringify(options).includes('invented-secret')); return child;
  });
  syncBuiltinESMExports();
  try {await run(child,()=>launches);} finally {t.mock.restoreAll();syncBuiltinESMExports();}
}
for (const change of ['none','generation','abort','wrongoperation']) {test(`opaque owner synthetic custody ${change}`, async t=>{
  await fakeOfficial(t,'exitdelay',async(child,launches)=>{
    let generation=1; const control=new AbortController(); const deadline=performance.now()+2000;
    const owner=createPrivateOfficialAuthOwner({operationRef:'invented-operation',executable:'/invented-binary',codexHome:'/invented-home',sandbox:'/invented-sandbox',generation:1,readGeneration:()=>generation,signal:control.signal,deadline});
    const facts=await owner.capture(); assert.equal(child.exitCode,0); assert.equal(facts.accountId,'invented-account');
    assert.ok(!JSON.stringify(facts).includes('invented-secret')); assert.equal(JSON.stringify(owner),'{}');
    await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/); assert.equal(launches(),1);
    if(change==='generation'){generation=2;} if(change==='abort'){control.abort();}
    let admits=0; let transferred;
    const selection={operationRef:change==='wrongoperation'?'different':'invented-operation',recipe:'codex-chatgpt',operationAbortSignal:control.signal,deadline,
      binding:{credentialGeneration:1,providerAccountRef:'invented-account'}};
    const admission={admit(material){assert.equal(child.exitCode,0); admits++; transferred=material.fields; return {kind:'admitted'};}};
    if(change==='none') {owner.admit(selection,admission); assert.equal(admits,1); assert.ok(transferred.every(x=>x.valueBytes.every(b=>b===0)));}
    else {assert.throws(()=>owner.admit(selection,admission),/PRIVATE_AUTH_REFUSED/);assert.equal(admits,0);}
    assert.throws(()=>owner.admit(selection,admission),/PRIVATE_AUTH_REFUSED/);owner.dispose();
  });
});}
import {acquireAndPublish} from './bootstrap.ts';
import {syntheticPool} from './synthetic-pool.mjs';
for(const scenario of ['publish','conflict','corruptReadback']) {test(`real PA owners with synthetic infrastructure: ${scenario}`,async t=>{
  await fakeOfficial(t,'exitdelay',async(child)=>{
    const db=syntheticPool({conflict:scenario==='conflict',corruptReadback:scenario==='corruptReadback'});
    const control=new AbortController(); const config={operationRef:'invented-operation',executable:'/invented-binary',codexHome:'/invented-home',sandbox:'/invented-sandbox',generation:1,readGeneration:()=>1,signal:control.signal,deadline:performance.now()+5000};
    const approval={approvedAccountId:'invented-account',tenantId:'synthetic-tenant',projectId:'synthetic-project',scopeDigest:'synthetic-unique-scope',validFromControlTime:1,claimBeforeControlTime:2000,expiresAtControlTime:3000,
      descriptor:{id:'codex-chatgpt-responses/v1',provider:'codex',credentialMode:'chatgpt-account',originHost:'chatgpt.com',originPort:443,upstreamMethod:'POST',upstreamPath:'/backend-api/codex/responses',
      forwardedRequestHeaderNames:['content-type'],requiredHeaderNames:['content-type'],credentialFieldNames:['authorization','chatgpt-account-id'],exactValues:{'content-type':'application/json'}}};
    if(scenario!=='publish') {await assert.rejects(acquireAndPublish(db.pool,config,approval),/PA_BOOTSTRAP_REFUSED/);return;}
    const pa=await acquireAndPublish(db.pool,config,approval); t.after(()=>pa.dispose());
    assert.equal(child.exitCode,0);assert.deepEqual(pa.binding,db.getBinding());assert.equal(pa.binding.providerAccountRef,'invented-account');
    assert.match(pa.binding.credentialBindingRef,/^pa-credential:/);assert.match(pa.binding.providerRouteRef,/^pa-route:/);
    assert.equal(db.records.length,1);assert.equal(db.records[0].record.kind,'issuance');
    assert.deepEqual(db.records[0].record.value.binding,pa.binding);
    assert.ok(!JSON.stringify(db.calls).includes('invented-secret'));assert.ok(!JSON.stringify(db.calls).includes('/invented-home'));
    const renderer=pa.createRendering('invented-operation');assert.ok(renderer.owner.rendering);
    assert.throws(()=>pa.createRendering('invented-operation'),/PA_BOOTSTRAP_REFUSED/);
  });
});}
import {assembleWithDarwinJoin} from './assembly.ts';
test('missing genuine Darwin finalizer refuses before acquisition, PA I/O or provider creation', async()=>{
  await assert.rejects(assembleWithDarwinJoin({connect(){throw new Error('must not connect');}}, {}, {}, {}),/DARWIN_ROUTE_JOIN_REQUIRED/);
});

test('owner disposal aborts an in-flight private child; no respawn',async t=>{
  await fakeOfficial(t,'hang',async(child,launches)=>{
    const owner=createPrivateOfficialAuthOwner({operationRef:'invented-operation',executable:'/invented-binary',codexHome:'/invented-home',sandbox:'/invented-sandbox',generation:1,readGeneration:()=>1,signal:new AbortController().signal,deadline:performance.now()+2000});
    const result=owner.capture();setTimeout(()=>owner.dispose(),75);
    await assert.rejects(result,/PRIVATE_AUTH_REFUSED/);assert.equal(launches(),1);assert.ok(child.signalCode);
    await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/);
  });
});
