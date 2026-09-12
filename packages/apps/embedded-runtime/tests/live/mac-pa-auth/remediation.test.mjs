import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {capturePrivate, HelperCleanupIndeterminate, pendingHelperObservations} from './auth-ipc.ts';
import {createPrivateOfficialAuthOwner, BINARY_SHA256} from './owner.ts';
import {acquireAndPublish} from './bootstrap.ts';
import {assembleWithDarwinJoin} from './assembly.ts';
import {syntheticPool} from './synthetic-pool.mjs';
const deferred = () => {let resolveFn;const promise=new Promise(resolve=>{resolveFn=resolve;});return {promise,resolve:resolveFn};};
// Entirely in-memory official-protocol double. No OS process, auth or database.
function memoryChild({stuck=false,closeOnly=false,holdClosure=false,token='invented-secret'}={}) {
  const child = new EventEmitter(); child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kills=0; child.methods=[];child.kill=()=>{child.kills++;return false;};
  child.stdin=new Writable({write(chunk,encoding,done){
    const request=JSON.parse(chunk.toString());child.methods.push(request.method);
    if (!stuck && request.id) {
      const result = request.method==='account/read'?{account:{type:'chatgpt'},requiresOpenaiAuth:true}:
        request.method==='getAuthStatus'?{authMethod:'chatgpt',requiresOpenaiAuth:true,authToken:token}:
        request.method==='account/rateLimits/read'?{accountId:'invented-account'}:{};
      queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,result})+'\n'));
    }
    done();
  },final(done){done();queueMicrotask(()=>{if(!stuck&&!holdClosure){child.emit('exit',0,null);child.emit('close');} else if(closeOnly){child.emit('close');}});}});
  return child;
}
async function inventedOfficial(t, child, run) {
  t.mock.method(fs,'realpath',async path=>path);
  t.mock.method(fs,'lstat',async()=>({isDirectory:()=>true,uid:process.getuid(),mode:0o700}));
  t.mock.method(fs,'open',async()=>({stat:async()=>({isFile:()=>true,mode:0o700}),close:async()=>{},
    createReadStream:()=>({async *[Symbol.asyncIterator](){yield Buffer.from('invented binary');}})}));
  const realHash=crypto.createHash;let hashes=0,launches=0;
  t.mock.method(crypto,'createHash',(...args)=>++hashes===1?{update(){return this;},digest:()=>BINARY_SHA256}:realHash(...args));
  t.mock.method(cp,'spawn',()=>{launches++;return child;});syncBuiltinESMExports();
  try {await run(()=>launches);} finally {t.mock.restoreAll();syncBuiltinESMExports();}
}
const config = (control=new AbortController(), readGeneration=()=>1) => ({operationRef:'invented-operation',executable:'/invented-binary',
  codexHome:'/invented-home',sandbox:'/invented-sandbox',generation:1,readGeneration,signal:control.signal,deadline:performance.now()+5000});
const approval = (approveCapture=async()=>true) => ({approveCapture,
  testSessionProvenance:'operator-owned-private-isolated-official-test-session',tenantId:'synthetic-tenant',projectId:'synthetic-project',scopeDigest:'synthetic-scope',
  validFromControlTime:1,claimBeforeControlTime:2000,expiresAtControlTime:3000,
  descriptor:{id:'codex-chatgpt-responses/v1',provider:'codex',credentialMode:'chatgpt-account',originHost:'chatgpt.com',originPort:443,
    upstreamMethod:'POST',upstreamPath:'/backend-api/codex/responses',forwardedRequestHeaderNames:['content-type'],requiredHeaderNames:['content-type'],
    credentialFieldNames:['authorization','chatgpt-account-id'],exactValues:{'content-type':'application/json'}}});
function gatePool(db, match) {
  const entered=deferred(), release=deferred();let fired=false;
  return {entered,release,pool:{async connect(){const client=await db.pool.connect();return {
    release:discard=>client.release(discard),async query(sql,values){
      // Execute the invented statement first: COMMIT tests preserve already-issued uncertainty.
      const result=await client.query(sql,values);
      if(!fired && match(sql,db)){fired=true;entered.resolve();await release.promise;}
      return result;
    }};}}};
}
for (const boundary of ['abort','deadline']) {test(`lifetime ${boundary} during pending SELECT prevents binding UPDATE and COMMIT`,async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const control=new AbortController(),auth=config(control);if(boundary==='deadline'){auth.deadline=performance.now()+150;}
    const db=syntheticPool(),gate=gatePool(db,sql=>sql.startsWith('SELECT head_version'));
    const pending=acquireAndPublish(gate.pool,auth,approval());await gate.entered.promise;
    const before=db.calls.length;
    if(boundary==='abort'){control.abort();}else {await new Promise(resolve=>{setTimeout(resolve,180);});}
    gate.release.resolve();await assert.rejects(pending,/PA_BOOTSTRAP_REFUSED/);
    assert.equal(db.getBinding(),null);assert.equal(db.records.length,0);
    assert.ok(!db.calls.slice(before).some(x=>/^(UPDATE|COMMIT)/.test(x.sql)));
  });
});}
test('expired deadline query fence works even before the timer callback runs',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const db=syntheticPool(),gate=gatePool(db,sql=>sql.startsWith('SELECT head_version'));
    const auth=config();const now=performance.now.bind(performance);
    const pending=acquireAndPublish(gate.pool,auth,approval());await gate.entered.promise;
    t.mock.method(performance,'now',()=>auth.deadline+1);
    gate.release.resolve();await assert.rejects(pending,/PA_BOOTSTRAP_REFUSED/);
    assert.equal(db.getBinding(),null);assert.ok(now()>0);
  });
});
for(const stage of ['binding-commit','issuance-commit']) {test(`abort preserves already-issued ${stage} without retry or rollback claim`,async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const db=syntheticPool(),control=new AbortController();
    const gate=gatePool(db,sql=>sql==='COMMIT' && (stage==='binding-commit'?db.getBinding()!==null:db.records.length===1));
    const pending=acquireAndPublish(gate.pool,config(control),approval());await gate.entered.promise;
    const before=db.calls.length;control.abort();gate.release.resolve();await assert.rejects(pending,error=>{
      assert.equal(error.message,'PA_BOOTSTRAP_REFUSED');
      assert.equal(error.publication.binding,stage==='binding-commit'?'unconfirmed':'acknowledged');
      if(stage==='issuance-commit'){assert.equal(error.publication.route,'acknowledged');assert.equal(error.publication.issuance,'unconfirmed');}
      return true;
    });
    assert.ok(db.getBinding());if(stage==='issuance-commit'){assert.equal(db.records.length,1);}
    assert.equal(db.calls.length,before);assert.equal(db.calls.filter(x=>x.sql.startsWith('UPDATE provider_access.materialization_owner')).length,1);
  });
});}
for(const outcome of ['allow','deny','throw','abort','generation','deadline','override']) {test(`same captured official account policy: ${outcome}`,async t=>{
  const child=memoryChild();await inventedOfficial(t,child,async launches=>{
    const db=syntheticPool(),control=new AbortController();let generation=1,calls=0;
    const auth=config(control,()=>generation);
    const input=approval(async metadata=>{
      calls++;assert.deepEqual(child.methods,['initialize','initialized','account/read','getAuthStatus','account/rateLimits/read','getAuthStatus','account/read']);
      assert.equal(metadata.accountId,'invented-account');assert.equal(db.calls.length,0);
      assert.equal(metadata.provenance,input.testSessionProvenance);
      assert.ok(!JSON.stringify(metadata).includes('invented-secret'));
      assert.throws(()=>{metadata.accountId='other';},TypeError);
      metadata.scope.descriptor.originHost='evil.invalid'; // independent policy clone must never modify publication
      if(outcome==='deny'){return false;}if(outcome==='throw'){throw new Error('invented-secret');}
      if(outcome==='abort'){control.abort();}if(outcome==='generation'){generation=2;}
      if(outcome==='deadline'){t.mock.method(performance,'now',()=>auth.deadline+1);}
      return outcome==='override'?{accountId:'other'}:true;
    });
    if(outcome==='allow') {
      const pa=await acquireAndPublish(db.pool,auth,input);t.after(()=>pa.dispose());
      assert.equal(pa.binding.providerAccountRef,'invented-account');assert.equal(pa.ownerFacts.descriptor.originHost,'chatgpt.com');
      assert.equal(db.records.length,1);assert.deepEqual(db.records[0].record.value.binding,pa.binding);
      pa.createRendering('invented-operation');assert.throws(()=>pa.createRendering('invented-operation'));
    } else {await assert.rejects(acquireAndPublish(db.pool,auth,input),e=>e.message==='PA_BOOTSTRAP_REFUSED');assert.equal(db.calls.length,0);}
    assert.equal(calls,1);assert.equal(launches(),1);
  });
});}
test('operator callback and inputs captured before acquisition awaits; callback mutation cannot replace policy',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const db=syntheticPool();let reads=0,original=0,replacement=0;
    const policy=approval();Object.defineProperty(policy,'approveCapture',{configurable:true,enumerable:true,get(){reads++;return async()=>{original++;return true;};}});
    const auth=config();const pending=acquireAndPublish(db.pool,auth,policy);
    Object.defineProperty(policy,'approveCapture',{value:async()=>{replacement++;return false;}});policy.tenantId='changed';auth.generation=99;
    const pa=await pending;t.after(()=>pa.dispose());assert.equal(pa.binding.tenantId,'synthetic-tenant');assert.equal(reads,1);assert.equal(original,1);assert.equal(replacement,0);
  });
});
const failIfUsed=()=>{throw new Error('synthetic dependency must not execute');};
function joinFixture(finish) {
  return {kernel:{platformTarget:{platform:'darwin',architecture:'arm64'},effectCustody:{admit:failIfUsed},hostBootId:'host-boot:synthetic',hostInstanceId:'host-instance:synthetic',
    hostCustody:{get:failIfUsed},launchRecords:{resolve:failIfUsed},workspaceOwner:{}},
    security:{repository:Object.fromEntries(['consumeAtomically','observe','settleAtomically','readAuthority','replaceAuthority'].map(k=>[k,failIfUsed])),
      decisions:{read:failIfUsed,retain:failIfUsed},policy:{read:failIfUsed},clock:{now:failIfUsed},digest:{digestCanonical:failIfUsed}},
    createSession:()=>({}),createPostClaimPreparation:()=>({prepareClaimed:failIfUsed}),finishDarwinRouteAndBindPublicHandle:finish};
}
for(const result of ['reject','hang','resolve']) {test(`shutdown immediately closes real PA/kernel when public disposer will ${result}; one shot`,async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    let retained,calls=0;const never=deferred(),failure=new Error('synthetic public cleanup failure');
    const owner=await assembleWithDarwinJoin(syntheticPool().pool,config(),approval(),joinFixture(async state=>{
      retained=state;return {handle:{synthetic:true},dispose(){calls++;assert.throws(()=>state.pa.createRendering('invented-operation'));return result==='reject'?Promise.reject(failure):result==='hang'?never.promise:Promise.resolve();}};
    }));
    const first=owner.dispose();assert.equal(owner.dispose(),first);
    assert.throws(()=>retained.pa.createRendering('invented-operation'),/PA_BOOTSTRAP_REFUSED/);
    await assert.rejects(retained.kernel.custody.open({}),/admission is unavailable/);
    if(result==='reject'){await assert.rejects(first,e=>e===failure);assert.equal(owner.cleanupStatus(),'failed');}
    else if(result==='hang'){await Promise.resolve();assert.equal(owner.cleanupStatus(),'pending');never.resolve();await first;}
    else {await first;assert.equal(owner.cleanupStatus(),'settled');}
    assert.equal(calls,1);
  });
});}
for(const fence of ['abort','generation','deadline']) {test(`post-finalizer ${fence} refuses handle and retires returned untransferred owner`,async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const entered=deferred(),release=deferred(),control=new AbortController();let generation=1,retained,disposed=0;
    const auth=config(control,()=>generation),join=joinFixture(async state=>{retained=state;entered.resolve();await release.promise;return {handle:{synthetic:true},dispose:async()=>{disposed++;}};});
    const pending=assembleWithDarwinJoin(syntheticPool().pool,auth,approval(),join);await entered.promise;
    if(fence==='abort'){control.abort();}if(fence==='generation'){generation=2;}if(fence==='deadline'){t.mock.method(performance,'now',()=>auth.deadline+1);}
    release.resolve();await assert.rejects(pending,asyncError=>{assert.equal(asyncError.message,'DARWIN_ASSEMBLY_REFUSED');return true;});
    await Promise.resolve();assert.equal(disposed,1);assert.throws(()=>retained.pa.createRendering('invented-operation'));
    await assert.rejects(retained.kernel.custody.open({}),/admission is unavailable/);
  });
});}
test('selected join getters read once before acquisition; mutation during finalizer cannot replace authority callbacks',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const entered=deferred(),release=deferred(),auth=config();let reads=0,called=0;
    const join=joinFixture(async()=>{called++;entered.resolve();await release.promise;return {handle:{synthetic:true},dispose:async()=>{}};});
    const original=join.finishDarwinRouteAndBindPublicHandle;
    let platformReads=0;
    Object.defineProperty(join.kernel,'platformTarget',{enumerable:true,get(){platformReads++;return {platform:platformReads===1?'darwin':'linux',architecture:'arm64'};}});
    Object.defineProperty(join,'finishDarwinRouteAndBindPublicHandle',{configurable:true,get(){reads++;return original;}});
    const pending=assembleWithDarwinJoin(syntheticPool().pool,auth,approval(),join);await entered.promise;
    auth.readGeneration=()=>99;auth.generation=99;join.createSession=failIfUsed;
    Object.defineProperty(join,'finishDarwinRouteAndBindPublicHandle',{value:failIfUsed});
    release.resolve();const owner=await pending;await owner.dispose();assert.equal(reads,1);assert.equal(called,1);assert.equal(platformReads,1);
  });
});
for(const layer of ['ipc','owner','bootstrap']) {test(`unconfirmed helper exit stays distinct through ${layer}, durable and observed after bounded refusal`,async t=>{
  const child=memoryChild({stuck:true});await inventedOfficial(t,child,async launches=>{
    const control=new AbortController(),auth=config(control),db=syntheticPool();
    const owner=layer==='owner'?createPrivateOfficialAuthOwner(auth):undefined;
    const pending=layer==='ipc'?capturePrivate(child,control.signal,auth.deadline):owner?owner.capture():acquireAndPublish(db.pool,auth,approval());
    setTimeout(()=>control.abort(),20);let failure;const start=performance.now();
    await assert.rejects(pending,error=>{failure=error;return error instanceof HelperCleanupIndeterminate && error.message==='HELPER_CLEANUP_INDETERMINATE';});
    assert.ok(performance.now()-start<1800);assert.ok(child.stdout.destroyed);
    assert.deepEqual(failure.observation.snapshot(),{exitObserved:false,closeObserved:false,recordPersisted:true});
    assert.ok(pendingHelperObservations().includes(failure.observation));assert.equal(db.calls.length,0);
    if(owner){await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/);assert.throws(()=>owner.admit({},{}),/PRIVATE_AUTH_REFUSED/);}
    assert.equal(launches(),layer==='ipc'?0:1);
    const ledger=await fs.readFile(new URL('./helper-attempts.jsonl',import.meta.url),'utf8');
    const rows=ledger.trim().split('\n').map(JSON.parse).filter(x=>x.attemptRef===failure.observation.attemptRef);
    assert.equal(rows.at(-1).outcome,'helper-cleanup-indeterminate');assert.ok(!JSON.stringify(rows).includes('invented-secret'));
    child.emit('close');assert.equal(failure.observation.snapshot().exitObserved,false);assert.ok(pendingHelperObservations().includes(failure.observation));
    child.emit('exit',null,'SIGKILL');await failure.observation.settled;
    assert.equal(failure.observation.snapshot().exitObserved,true);assert.ok(!pendingHelperObservations().includes(failure.observation));
    const after=await fs.readFile(new URL('./helper-attempts.jsonl',import.meta.url),'utf8');
    assert.equal(after.trim().split('\n').map(JSON.parse).filter(x=>x.attemptRef===failure.observation.attemptRef).at(-1).outcome,'helper-termination-observed');
  });
});}
import {runTrustedOperator} from './cli.ts';
for(const result of ['allow','deny','indeterminate']) {test(`compiled operator CLI integration: ${result}`,async t=>{
  const child=memoryChild({stuck:result==='indeterminate'});
  await inventedOfficial(t,child,async launches=>{
    const control=new AbortController(),db=syntheticPool();let published=0,retained;
    const pending=runTrustedOperator({pool:db.pool,auth:config(control),approval:approval(async()=>result==='allow'),
      async withPublishedOwner(pa){published++;retained=pa;pa.createRendering('invented-operation');}});
    if(result==='indeterminate'){setTimeout(()=>control.abort(),20);}
    const outcome=await pending;
    assert.equal(outcome.exitCode,result==='allow'?0:result==='deny'?1:2);
    assert.equal(outcome.message,result==='allow'?'MAC_PA_CALLBACK_COMPLETED':result==='deny'?'MAC_PA_REFUSED':'HELPER_CLEANUP_INDETERMINATE');
    assert.equal(published,result==='allow'?1:0);assert.equal(launches(),1);
    if(retained){assert.throws(()=>retained.createRendering('invented-operation'));}
    if(result==='indeterminate') {
      assert.ok(pendingHelperObservations().includes(outcome.observation));
      child.emit('exit',null,'SIGKILL');child.emit('close');await outcome.observation.settled;
    }
  });
});}
test('compiled operator CLI rejects absent provenance/policy before any acquisition',async()=>{
  const result=await runTrustedOperator({pool:{connect:failIfUsed},auth:{},approval:{},withPublishedOwner:failIfUsed});
  assert.deepEqual(result,{kind:'refused',message:'MAC_PA_REFUSED',exitCode:1});
});
import nodeFs from 'node:fs';
test('denied same-capture approval erases owned token/account buffers before refusal',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const allocate=Buffer.alloc;const owned=[];
    t.mock.method(Buffer,'alloc',(size,...args)=>{const bytes=allocate(size,...args);if(size===Buffer.byteLength('invented-secret')||size===Buffer.byteLength('invented-account')){owned.push(bytes);}return bytes;});
    const db=syntheticPool();await assert.rejects(acquireAndPublish(db.pool,config(),approval(async()=>false)),/PA_BOOTSTRAP_REFUSED/);
    assert.ok(owned.length>=3);assert.ok(owned.every(bytes=>bytes.every(value=>value===0)));assert.equal(db.calls.length,0);
  });
});
test('failure to persist final helper cleanup record cannot release captured material',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const write=nodeFs.writeSync;let denied=0;
    t.mock.method(nodeFs,'writeSync',(fd,data,...args)=>{
      if(JSON.parse(data.toString()).outcome==='helper-cleanup-observed'){denied++;throw new Error('synthetic journal failure');}
      return write(fd,data,...args);
    });syncBuiltinESMExports();
    const db=syntheticPool();await assert.rejects(acquireAndPublish(db.pool,config(),approval()),error=>error.message==='PA_BOOTSTRAP_REFUSED');
    assert.equal(denied,1);assert.equal(db.calls.length,0);
  });
});
import {ContainedTurnKernelCustodyAdapter} from '@agent-teams/agent-execution/composition';
test('owner returned by a constructor after synchronous abort is retired before finalizer effects',async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const control=new AbortController();let sealed=0,finished=0,pa;
    const original=ContainedTurnKernelCustodyAdapter.prototype.sealAdmission;
    t.mock.method(ContainedTurnKernelCustodyAdapter.prototype,'sealAdmission',function(){sealed++;return original.call(this);});
    const join=joinFixture(async()=>{finished++;throw new Error('must not finalize');});
    join.createSession=value=>{pa=value;return {};};
    Object.defineProperty(join.kernel.hostCustody,'get',{get(){control.abort();return failIfUsed;}});
    await assert.rejects(assembleWithDarwinJoin(syntheticPool().pool,config(control),approval(),join),/DARWIN_ASSEMBLY_REFUSED/);
    assert.equal(finished,0);assert.ok(sealed>0);assert.throws(()=>pa.createRendering('invented-operation'));
  });
});

// Ledger I/O for this regression set is entirely in memory.
let ledger;
beforeEach(t=>{
  ledger='';
  t.mock.method(nodeFs,'openSync',()=>12345);
  t.mock.method(nodeFs,'writeSync',(fd,data,offset=0,length=data.length-offset)=>{
    ledger+=Buffer.isBuffer(data)?data.subarray(offset,offset+length).toString():data;
    return length;
  });
  t.mock.method(nodeFs,'fsyncSync',()=>{});
  t.mock.method(nodeFs,'closeSync',()=>{});
  const read=fs.readFile;
  t.mock.method(fs,'readFile',(...args)=>String(args[0]).endsWith('/helper-attempts.jsonl')?Promise.resolve(ledger):read(...args));
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
});
for(const indeterminate of [false,true]) {test(`one-byte ledger writes complete before fsync: indeterminate=${indeterminate}`,async t=>{
  t.mock.method(nodeFs,'writeSync',(fd,data,offset)=>{ledger+=data.subarray(offset,offset+1).toString();return 1;});
  t.mock.method(nodeFs,'fsyncSync',()=>{assert.ok(ledger.endsWith('\n'));ledger.trim().split('\n').forEach(JSON.parse);});
  syncBuiltinESMExports();
  const child=memoryChild({holdClosure:indeterminate}),control=new AbortController();
  const pending=capturePrivate(child,control.signal,performance.now()+5000);
  if(indeterminate){
    child.stdin.once('finish',()=>control.abort());
    let observation;
    await assert.rejects(pending,e=>{observation=e.observation;return e instanceof HelperCleanupIndeterminate;});
    assert.equal(observation.snapshot().recordPersisted,true);
    assert.equal(JSON.parse(ledger.trim().split('\n').at(-1)).outcome,'helper-cleanup-indeterminate');
    child.emit('exit',null,'SIGKILL');child.emit('close');await observation.settled;
  }else{
    const material=await pending;assert.equal(material.token.toString(),'invented-secret');
    material.token.fill(0);material.accountId.fill(0);
    assert.equal(JSON.parse(ledger.trim().split('\n').at(-1)).outcome,'helper-cleanup-observed');
  }
  assert.ok(!ledger.includes('invented-secret'));assert.ok(!ledger.includes('invented-account'));
});}
for(const progress of [0,-1,0.5,NaN,Infinity,999999,undefined]) {test(`invalid ledger progress refuses and remains unpersisted: ${progress}`,async t=>{
  let writes=0,syncs=0;
  t.mock.method(nodeFs,'writeSync',(fd,data,offset)=>{writes++;if(writes===1){ledger+=data.subarray(offset,offset+1).toString();return 1;}return progress;});
  t.mock.method(nodeFs,'fsyncSync',()=>{syncs++;});syncBuiltinESMExports();
  const child=memoryChild({stuck:true});let observation;
  await assert.rejects(capturePrivate(child,new AbortController().signal,performance.now()+5000),e=>{
    observation=e.observation;return e instanceof HelperCleanupIndeterminate&&e.message==='HELPER_CLEANUP_INDETERMINATE';
  });
  assert.equal(observation.snapshot().recordPersisted,false);assert.equal(syncs,0);assert.deepEqual(child.methods,[]);
  child.emit('exit',null,'SIGKILL');child.emit('close');await observation.settled;
  assert.equal(observation.snapshot().recordPersisted,false);
});}
test('abort after final RPC interrupts closure wait, retires admission, and retains observation',async t=>{
  const child=memoryChild({holdClosure:true});
  await inventedOfficial(t,child,async launches=>{
    const control=new AbortController(),auth=config(control);auth.deadline=performance.now()+60000;
    const owner=createPrivateOfficialAuthOwner(auth),finished=deferred();
    child.stdin.once('finish',finished.resolve);
    const pending=owner.capture();await finished.promise;
    assert.equal(child.methods.at(-1),'account/read');assert.equal(child.methods.filter(x=>x==='account/read').length,2);
    const start=performance.now();control.abort();let observation;
    await assert.rejects(pending,e=>{observation=e.observation;return e instanceof HelperCleanupIndeterminate;});
    assert.ok(performance.now()-start<1800);assert.ok(child.kills>0);assert.ok(child.stdout.destroyed);
    assert.deepEqual(observation.snapshot(),{exitObserved:false,closeObserved:false,recordPersisted:true});
    assert.ok(pendingHelperObservations().includes(observation));
    await assert.rejects(owner.capture(),/PRIVATE_AUTH_REFUSED/);assert.throws(()=>owner.admit({},{}),/PRIVATE_AUTH_REFUSED/);
    assert.equal(launches(),1);
    child.emit('close');assert.equal(observation.snapshot().exitObserved,false);
    child.emit('exit',null,'SIGKILL');await observation.settled;
    assert.ok(!pendingHelperObservations().includes(observation));
  });
});

test('published retained inventory is exact frozen raw PA identity, nonconsuming and never serialized',async t=>{
  await inventedOfficial(t,memoryChild(),async launches=>{
    const db=syntheticPool(),pa=await acquireAndPublish(db.pool,config(),approval());
    t.after(()=>pa.dispose());
    for(let i=0;i<2;i++) {pa.withCredentialOutputInventory('invented-operation',inventory=>{
      assert.deepEqual(inventory,{credentialBindingDigest:pa.binding.credentialBindingDigest,
        credentialGeneration:1,sensitiveOutputTokens:['invented-secret','invented-account']});
      assert.ok(Object.isFrozen(inventory));assert.ok(Object.isFrozen(inventory.sensitiveOutputTokens));
      assert.equal(db.records.length,1);assert.deepEqual(db.getBinding(),pa.binding);
      return true;
    });}
    assert.ok(!JSON.stringify(pa).includes('invented-secret'));
    assert.ok(!JSON.stringify(Object.getOwnPropertyDescriptors(pa)).includes('invented-secret'));
    pa.createRendering('invented-operation');
    assert.throws(()=>pa.createRendering('invented-operation'));
    assert.throws(()=>pa.withCredentialOutputInventory('invented-operation',()=>true));
    assert.equal(launches(),1);
  });
});
for(const stage of ['before','during']) {for(const reason of ['abort','deadline','generation','disposed','admitted'])
{test(`inventory lifetime refusal ${stage} callback: ${reason}`,async t=>{
  await inventedOfficial(t,memoryChild(),async launches=>{
    const control=new AbortController();let generation=1,calls=0;
    const auth=config(control,()=>generation),pa=await acquireAndPublish(syntheticPool().pool,auth,approval());
    const invalidate=()=>{
      if(reason==='abort'){control.abort();}
      if(reason==='deadline'){t.mock.method(performance,'now',()=>auth.deadline+1);}
      if(reason==='generation'){generation++;}
      if(reason==='disposed'){pa.dispose();}
      if(reason==='admitted'){pa.createRendering('invented-operation');}
    };
    if(stage==='before'){invalidate();}
    assert.throws(()=>pa.withCredentialOutputInventory('invented-operation',()=>{
      calls++;invalidate();return true;
    }),e=>e.message==='PA_BOOTSTRAP_REFUSED');
    assert.equal(calls,stage==='before'?0:1);
    assert.throws(()=>pa.createRendering('invented-operation'));
    assert.equal(launches(),1);
  });
});}}
for(const reason of ['wrong-op','throw','false','async','getter'])
{test(`inventory consumer fails closed: ${reason}`,async t=>{
  await inventedOfficial(t,memoryChild(),async launches=>{
    const pa=await acquireAndPublish(syntheticPool().pool,config(),approval());let reads=0,calls=0;
    const callback=reason==='async'?async()=>{calls++;return true;}:()=>{
      calls++;if(reason==='throw'){throw new Error('invented-secret');}
      // oxlint-disable-next-line unicorn/no-thenable -- deliberately hostile thenable fixture proving the consumer treats it as opaque, never awaits it
      if(reason==='getter'){return {get then(){reads++;throw new Error('invented-secret');}};}
      return false;
    };
    assert.throws(()=>pa.withCredentialOutputInventory(reason==='wrong-op'?{}:'invented-operation',callback),
      e=>e.message==='PA_BOOTSTRAP_REFUSED'&&!JSON.stringify(e).includes('invented-secret'));
    assert.equal(reads,0);if(['wrong-op','async'].includes(reason)){assert.equal(calls,0);}
    assert.throws(()=>pa.createRendering('invented-operation'));assert.equal(launches(),1);
  });
});}
for(const size of [4096,4097]) {test(`inventory UTF8 token bound ${size} without splitting or trimming`,async t=>{
  const token='x'.repeat(size);
  await inventedOfficial(t,memoryChild({token}),async launches=>{
    const pa=await acquireAndPublish(syntheticPool().pool,config(),approval());t.after(()=>pa.dispose());let calls=0;
    const consume=inventory=>{calls++;assert.equal(inventory.sensitiveOutputTokens[0],token);return true;};
    if(size===4096){pa.withCredentialOutputInventory('invented-operation',consume);pa.createRendering('invented-operation');}
    else {assert.throws(()=>pa.withCredentialOutputInventory('invented-operation',consume));assert.throws(()=>pa.createRendering('invented-operation'));}
    assert.equal(calls,size===4096?1:0);assert.equal(launches(),1);
  });
});}

for(const boundary of ['owner','bootstrap']) {for(const carrier of ['ordinary-promise','bound-async','then-getter','thenable-getter'])
{test(`inventory rejected callback carrier ${boundary}: ${carrier}`,async t=>{
  await inventedOfficial(t,memoryChild(),async()=>{
    const auth=config(),db=syntheticPool();
    const owner=boundary==='owner'?createPrivateOfficialAuthOwner(auth):await acquireAndPublish(db.pool,auth,approval());
    if(boundary==='owner'){await owner.capture();}
    let calls=0,reads=0,unhandled=0,admissions=0;
    const onUnhandled=()=>{unhandled++;};
    process.on('unhandledRejection',onUnhandled);
    t.after(()=>{process.removeListener('unhandledRejection',onUnhandled);owner.dispose();});
    const reason=new Proxy(new Error('invented-secret'),{get(){reads++;throw new Error('rejection must remain opaque');}});
    const body=value=>{
      calls++;
      assert.deepEqual(boundary==='owner'?value:value.sensitiveOutputTokens,['invented-secret','invented-account']);
      // oxlint-disable-next-line unicorn/no-thenable -- deliberately hostile thenable fixture proving the consumer treats it as opaque, never awaits it
      if(carrier==='thenable-getter'){return {get then(){reads++;throw reason;}};}
      const rejected=Promise.reject(reason);
      // oxlint-disable-next-line unicorn/no-thenable -- deliberately hostile thenable fixture proving the consumer treats it as opaque, never awaits it
      if(carrier==='then-getter'){Object.defineProperty(rejected,'then',{get(){reads++;throw reason;}});}
      return rejected;
    };
    // oxlint-disable-next-line no-extra-bind -- carrier==='bound-async' deliberately exercises a Function.prototype.bind-wrapped callback, not the bind's no-op thisArg
    const callback=carrier==='bound-async'?(async value=>{calls++;assert.deepEqual(boundary==='owner'?value:value.sensitiveOutputTokens,['invented-secret','invented-account']);throw reason;}).bind(null):body;
    const invoke=consume=>boundary==='owner'?owner.withCredentialOutputTokens(auth.operationRef,consume):owner.withCredentialOutputInventory(auth.operationRef,consume);
    assert.throws(()=>invoke(callback),error=>{
      assert.equal(error.message,boundary==='owner'?'PRIVATE_AUTH_REFUSED':'PA_BOOTSTRAP_REFUSED');
      assert.ok(!JSON.stringify(error).includes('invented-secret'));return true;
    });
    assert.equal(calls,1);
    assert.throws(()=>invoke(()=>{admissions++;return true;}));
    if(boundary==='owner'){assert.throws(()=>owner.admit({}, {admit(){admissions++;}}));}
    else {assert.throws(()=>owner.createRendering(auth.operationRef));}
    assert.equal(admissions,0);
    await new Promise(resolve=>{setImmediate(resolve);});
    await new Promise(resolve=>{setImmediate(resolve);});
    assert.equal(unhandled,0);assert.equal(reads,0);
  });
});}}
