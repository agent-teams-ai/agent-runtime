import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import fs, {readFileSync} from 'node:fs';

// Built artifacts, exactly as other APP tests. No production source rewriting.
const auditRoot = new URL('../../../../../', import.meta.url);
const feature = new URL('packages/contexts/agent-execution/dist/features/contained-agent-turn/', auditRoot);
const docker = new URL('adapters/outbound/host-custody/docker/', feature);
const app = new URL('../../dist/composition/', import.meta.url);
const unused = () => {throw Error('unexpected unrelated owner call');};
let system;
let acknowledge;
let privilegeCalls = 0;
const stub = (url, namedExports) => mock.module(url, {exports: namedExports});
// Isolated worker: all kernel effects and transport are simulated, never real I/O.
// Copy the fs API, not its ESM namespace: namespace.default would retain the
// original object whose nonconfigurable constants Node's mock loader redefines.
stub('node:fs', {...fs, ...Object.fromEntries(
  ['closeSync', 'fstatSync', 'openSync', 'readFileSync', 'realpathSync', 'statSync'].map(name =>
    [name, (...args) => system[name](...args)]))});
stub('node:child_process', {execFileSync: (...args) => system.execFileSync(...args)});
stub(new URL('node-linux-route-privilege.js', docker), {assertNodeLinuxRoutePrivilege: () => {privilegeCalls++;}});
const {custodyDataRecord} = await import(new URL('../host-custody-inert-record.js', docker));
stub(new URL('../contained-turn-kernel-custody-entrypoint.js', docker), {custodyDataRecord, createNodeHostHttpConsumptionJournal: unused});
const engine = await import(new URL('engine/node-unix-socket-docker-engine.js', docker));
const snapshot = await import(new URL('engine/docker-boundary-snapshot.js', docker));
const networkCleanup = await import(new URL('engine/docker-operation-network-codec.js', docker));
const guards = await import(new URL('docker-host-custody-lifecycle-guards.js', docker));
const opener = await import(new URL('node-linux-exclusive-route.js', docker));
const provenance = await import(new URL('node-docker-route-provenance.js', docker));
stub(new URL('docker-provider-process-entrypoint.js', docker), {
  createNodeDockerRouteProvenance: provenance.createNodeDockerRouteProvenance,
  NodeUnixSocketDockerEngine: engine.NodeUnixSocketDockerEngine,
  snapshotDockerEnginePolicy: snapshot.snapshotDockerEnginePolicy,
  awaitNetworkCleanupWork: networkCleanup.awaitNetworkCleanupWork,
  sameDockerAuthority: guards.sameDockerAuthority,
  openNodeLinuxExclusiveRoute: opener.openNodeLinuxExclusiveRoute,
  LinuxExclusiveRouteOpeningError: opener.LinuxExclusiveRouteOpeningError,
  createNodeLinuxDockerResidueCustody: () => ({lifecycle: {}, disposeResidue: async () => 'released'}),
  NodeDockerCustodyJournalStorage: Object.assign(function NodeDockerCustodyJournalStorage() {}, {
    async open() {return {close: async () => {}};},
  }),
  HostHttpEgressV4NodeStorage: function HostHttpEgressV4NodeStorage() {},
  HostHttpEgressV4Journal: function HostHttpEgressV4Journal() {},
});
// This scenario qualifies Linux provenance only; no Darwin capability is minted.
stub(new URL('composition/darwin-codex-route-enforcement.js', feature), {
  readDarwinCodexRouteEnforcementTarget() {
    // No Darwin capability exists in this Linux-only scenario.
  },
});
const capability = await import(new URL('composition/contained-turn-route-enforcement-capability.js', feature));
stub('@agent-teams/agent-execution/composition', {...capability,
  NodeHttpEgressBoundaryIds: class {fresh = unused;},
  NodeHttpEgressTrustedResolver: class {resolve = unused;},
  PostgresHttpEgressEvidence: class {digest = unused; record = unused;},
});
stub('@agent-teams/runtime-security/composition', {snapshotDispatchAuthorityHead: unused});
stub('@agent-teams/provider-access/composition', {snapshotRouteSelectionCurrent: unused});
stub(new URL('contained-turn-http-egress-upstream.js', app), {
  createContainedTurnHttpEgressRoute: unused,
  createContainedTurnHttpUpstreamTransport: () => ({beginOpen: unused}),
});
stub(new URL('contained-turn-linux-route-binding.js', app), {createContainedTurnLinuxRouteBinding: unused});
// Keep real infrastructure capture; only acknowledged PA/RS receipts are synthetic.
const authorityModule = await import(new URL('linux-codex-deployment-authority.js', app));
stub(new URL('linux-codex-deployment-authority.js', app), {...authorityModule,
  createLinuxCodexDeploymentAuthority: () => ({take: kernel => acknowledge(kernel), bind() {}, bindStore() {}, dispose() {}}),
});

async function prepareSyntheticRouteEnvironment() {
const imp = p=>import(new URL(p,docker));
const {decodeInspection,decodeEngineIdentity}=await imp('engine/docker-engine-codec.js');
const {NodeUnixSocketDockerEngine}=await imp('engine/node-unix-socket-docker-engine.js');
const {encodeCreateRequest,containerName}=await imp('engine/docker-create-request.js');
const {canonicalJsonSha256}=await imp('engine/docker-canonical-json.js');
const {operationNetworkName}=await imp('engine/docker-operation-network-codec.js');
const {linuxExclusiveRouteSeccomp}=await imp('linux-exclusive-route-policy.js');
const cap=await import(new URL('composition/contained-turn-route-enforcement-capability.js',feature));
const {retainDockerNativeBrokerRoute}=await import(new URL('composition/docker-native-broker-route.js',feature));
const f=await import(new URL('./packages/contexts/agent-execution/tests/fixtures/docker-engine-test-fixture.ts',auditRoot));
const fixture=JSON.parse(readFileSync(new URL('./packages/contexts/agent-execution/tests/fixtures/docker-engine-api-v1.47-engine-29.6.1-redacted.json', auditRoot),'utf8'));
const endpointIdentity={canonicalSocketPath:'/audit-synthetic/docker.sock',daemonBootGenerationSha256:f.DAEMON_BOOT,hostBootGenerationSha256:f.HOST_BOOT};
const base=f.policy('/audit-synthetic');
const identity=decodeEngineIdentity(fixture.info,base,endpointIdentity);
const netBinding={...Object.fromEntries(['operationSha256','executionGenerationSha256','networkHandleSha256'].map(k=>[k,'3'.repeat(64)])),
 ...Object.fromEntries(['daemonIdentitySha256','daemonBootGenerationSha256','hostIdentitySha256','hostBootGenerationSha256'].map(k=>[k,identity[k]])),
 ownerIdentitySha256:f.OWNER_IDENTITY,operationNonceSha256:f.NONCE,launchFingerprintSha256:f.FINGERPRINT};
const network=operationNetworkName(netBinding);
const seccomp=linuxExclusiveRouteSeccomp();
const operationPolicy={...base,allowedNetworkName:network,seccompProfileJson:seccomp.json,seccompProfileSha256:seccomp.sha256};
const identityPolicy={...operationPolicy,allowedNetworkName:'ar-identity-read-only'};
const input=f.createInput('/audit-synthetic');
const body=encodeCreateRequest(input,operationPolicy);
const {HostConfig,...Config}=body;
const wire={AppArmorProfile:operationPolicy.appArmorProfile,Config,HostConfig,
 Id:f.CONTAINER,Name:'/'+containerName(f.NONCE),
 Mounts:HostConfig.Mounts.map(m=>({Destination:m.Target,Propagation:'rprivate',RW:m.ReadOnly!==true,Source:m.Source,Type:'bind'})),
 State:{Dead:false,Error:'',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z',OOMKilled:false,Paused:false,Pid:4242,Restarting:false,Running:true,StartedAt:'2026-01-01T00:00:00Z',Status:'running'}};
const authority={...Object.fromEntries(['daemonIdentitySha256','daemonBootGenerationSha256','hostIdentitySha256','hostBootGenerationSha256'].map(k=>[k,identity[k]])),
 containerId:f.CONTAINER,imageDigest:input.imageDigest,ownerIdentitySha256:input.ownerIdentitySha256,
 operationNonceSha256:input.operationNonceSha256,launchFingerprintSha256:input.launchFingerprintSha256,
 createSpecificationSha256:canonicalJsonSha256({Name:containerName(f.NONCE),Request:body})};
assert.equal(decodeInspection(wire,authority,identity,operationPolicy).existence,'present');
assert.notEqual(network,identityPolicy.allowedNetworkName);
let mismatch;
assert.throws(()=>decodeInspection(wire,authority,identity,identityPolicy),e=>{mismatch=e;return e.code==='authority-conflict';});
assert.match(mismatch.stack,/resourceFacts/);
console.log('PASS codec: exact wire + authority accepted with operation policy; changing only policy network refuses in resourceFacts');
const calls=[];
const client={async endpointIdentity(){return endpointIdentity;},async buffered(r){
 assert.equal(r.method,'GET');calls.push(r.path);
 let value;if(r.path==='/v1.47/info'){value=fixture.info;}
 else {assert.match(r.path,/^\/v1\.47\/containers\/[a-f0-9]{64}\/json$/);value=wire;}
 return {statusCode:200,contentType:'application/json',body:Buffer.from(JSON.stringify(value))};
},async stream(){throw Error('unexpected stream');}};
const good=new NodeUnixSocketDockerEngine({client,policy:operationPolicy});
const bad=new NodeUnixSocketDockerEngine({client,policy:identityPolicy});
assert.equal((await good.inspect(authority,f.call())).existence,'present');
await assert.rejects(bad.inspect(authority,f.call()),{code:'authority-conflict'});
console.log('PASS actual Node Engine inspect: synthetic GET transport reproduces policy mismatch; no Docker/socket/network');
for(const key of ['containerId','ownerIdentitySha256','operationNonceSha256','createSpecificationSha256']) {
 await assert.rejects(good.inspect({...authority,[key]:'9'.repeat(64)},f.call()));
}
await assert.rejects(good.inspect({...authority,daemonBootGenerationSha256:'9'.repeat(64)},f.call()),{code:'daemon-identity-changed'});
console.log('PASS exact-authority negatives: container, owner, nonce, create digest, daemon generation');
const {createHash}=await import('node:crypto');
const {persistentKernel}=await import('./route-provenance-kernel.ts');
const {BoundedUnixHttpClient}=await imp('engine/bounded-unix-http.js');
const {createNodeDockerDeploymentRecipe}=await import(new URL('composition/node-docker-deployment-recipe.js',feature));
const {createLinuxCodexDeploymentResources}=await import(new URL('./packages/apps/embedded-runtime/dist/composition/linux-codex-deployment.js',auditRoot));
const pinBytes=Buffer.from('pinned synthetic tool');
const pin={path:'/synthetic/tool',sha256:createHash('sha256').update(pinBytes).digest('hex')};
const descriptors=new Map(); const kernels=new Map(); let nextFd=40;
system={
 realpathSync:p=>p,
 openSync(p){assert.ok(p===pin.path||/^\/proc\/\d+\/ns\/net$/.test(p));const fd=nextFd++;descriptors.set(fd,p);return fd;},
 closeSync(fd){assert.ok(descriptors.delete(fd));},
 fstatSync(fd){const p=descriptors.get(fd);assert.ok(p);return p===pin.path?
  {isFile:()=>true,uid:0,nlink:1,mode:0o100755,size:pinBytes.length,mtimeMs:1,ctimeMs:1}:
  {dev:4n,ino:BigInt(p.split('/')[2])};},
 readFileSync(fd){assert.equal(descriptors.get(fd),pin.path);return pinBytes;},
 statSync(p){return {dev:4n,ino:p==='/proc/self/ns/net'?1n:BigInt(p.split('/')[2])};},
 execFileSync(p,args,config){assert.equal(p,'/proc/self/fd/3');
  const ns=descriptors.get(config.stdio[5]);assert.ok(ns);
  let state=kernels.get(ns);if(!state){state=persistentKernel({now:()=>performance.now()});kernels.set(ns,state);}
  assert.deepEqual(args.slice(0,3),['--net=/proc/self/fd/5','--','/proc/self/fd/4']);
  if(args.length===5){state.kernel.transact(args[4]);return Buffer.alloc(0);}
  assert.deepEqual(args.slice(3),['-j','list','table','inet','ar_provider_route_v1']);
  return Buffer.from(JSON.stringify(state.kernel.readRules()));
 }
};
const containers=new Map([[authority.containerId,wire]]); const inspected=[];
BoundedUnixHttpClient.prototype.endpointIdentity=client.endpointIdentity;
BoundedUnixHttpClient.prototype.buffered=async function(r){
 assert.equal(r.method,'GET');
 if(r.path==='/v1.47/info'){return {statusCode:200,contentType:'application/json',body:Buffer.from(JSON.stringify(fixture.info))};}
 const match=/^\/v1\.47\/containers\/([a-f0-9]{64})\/json$/.exec(r.path);assert.ok(match); inspected.push(match[1]);
 const value=containers.get(match[1]);
 return {statusCode:value?200:404,contentType:'application/json',body:Buffer.from(JSON.stringify(value??{message:'No such container'}))};
};
return {
 identityPolicy, pin, cap, bad, good, createNodeDockerDeploymentRecipe, createLinuxCodexDeploymentResources,
 NodeUnixSocketDockerEngine, f, operationPolicy, operationNetworkName, netBinding, input, encodeCreateRequest,
 canonicalJsonSha256, containerName, containers, wire, authority, retainDockerNativeBrokerRoute,
 descriptors, BoundedUnixHttpClient, kernels, inspected,
};
}

const subjectOf=b=>Object.fromEntries(['operationId','attemptId','custodyId','executionGenerationId','authorityVectorDigest','hostBootId'].map(k=>[k,b[k]]));

test('deployment selected route retains each operation Engine through closure and historical removal', async () => {
const {
 identityPolicy, pin, cap, bad, good, createNodeDockerDeploymentRecipe, createLinuxCodexDeploymentResources,
 NodeUnixSocketDockerEngine, f, operationPolicy, operationNetworkName, netBinding, input, encodeCreateRequest,
 canonicalJsonSha256, containerName, containers, wire, authority, retainDockerNativeBrokerRoute,
 descriptors, BoundedUnixHttpClient, kernels, inspected,
}=await prepareSyntheticRouteEnvironment();
const target={provider:'codex',providerAdapter:'adapter:test',binaryClosure:'@openai/codex:0.153.4+linux-x64',platform:`${process.platform}-${process.arch}`,credentialRoute:'route:test',storageTopology:'storage:test',transportTopology:'transport:test',failureDomain:'host:test'};
const binding={tenantId:'tenant:test',projectId:'project:test',scopeDigest:'scope:test',
 operationId:'operation:test',attemptId:'attempt:test',custodyId:'custody:test',sourceRevision:'849833c00c76f465304f66e013ff8d61e45ff098',
 binaryRevision:target.binaryClosure,hostBootId:'boot:test',executionGenerationId:'generation:test',adapterRevision:target.providerAdapter,capabilityManifestRevision:'manifest:test',authorityVectorDigest:'authority:test',
 providerAccountRef:'account:test',accessRef:'access:test',bindingRevision:3,credentialBindingRef:'credential:test',providerRouteRef:'route:test',routeRevision:'revision:1',credentialBindingDigest:'opaque:test',credentialGeneration:7};
let nominalInspections=0;
const mintPolicy=structuredClone(identityPolicy); const mintPin={...pin};
const gate=cap.createContainedTurnRouteEnforcement({qualificationTarget:target,binding,enginePolicy:mintPolicy,
 engine:{inspect:async(a,c)=>{nominalInspections++;
  try {return await bad.inspect(a,c);} catch (error) {
    console.log('nominal identity inspector refused', error.code, error.stack); throw error;
  }
 }},nsenter:mintPin,nft:mintPin});
mintPolicy.memoryBytes += 4096; mintPolicy.allowedEnvironmentKeys.push("MUTATED"); mintPin.sha256="f".repeat(64);
const makeRecipe=(b=binding,changes={})=>createNodeDockerDeploymentRecipe({enginePolicy:identityPolicy,
 routeSubject:subjectOf(b),custodyJournalRoot:'/synthetic/custody',resourceJournalRoot:'/synthetic/resources',nsenter:pin,nft:pin,
 consumption:{directory:{path:'/synthetic/consumption',device:'1',inode:'1'},readEnvelope(){throw Error('unused');}},...changes});
const selectRecipe=(recipe,b=binding)=>{
 acknowledge=kernel=>{assert.equal(kernel,b);return {binding:b,input:{subject:{...b,hostInstanceId:'host:test',scope:{tenantId:b.tenantId,projectId:b.projectId},runtimeSecurityRequest:{claimBindingDigest:'claim:test'}}},acceptedDispatch:{authority:{authorityGeneration:1}},upstream:{}};};
 const deployment=createLinuxCodexDeploymentResources({imageInitLock:{},cleanupMilliseconds:1000,sourceRevision:binding.sourceRevision,deploymentId:'synthetic',
 pool:{connect(){throw Error('unused');}},dns:{},transport:{},currentAuthority:{runtimeSecurity:{readAuthority(){throw Error('unused');}},providerAccess:{readCurrent(){throw Error('unused');}}},
 currentPolicy(){return {};},authorities:{},createProviderAccess(){return {dispose(){}};},signer:{},clock:{},
 recipe(){return {...recipe,nativeFiles:{},connection:{},hostSession:{}};}
 },{hostBootId:b.hostBootId,hostInstanceId:'host:test'},gate);
 return deployment.resources.select({kernel:b,record:{}});
};
const sourcePolicy=structuredClone(identityPolicy); const sourceSubject=subjectOf(binding); const sourcePin={...pin};
const fresh=makeRecipe(binding,{enginePolicy:sourcePolicy,routeSubject:sourceSubject,nsenter:sourcePin,nft:sourcePin});
sourcePolicy.memoryBytes+=4096;sourcePolicy.allowedEnvironmentKeys.push('MUTATED');sourceSubject.operationId='mutated';sourcePin.sha256='f'.repeat(64);
const originalInspect=NodeUnixSocketDockerEngine.prototype.inspect;const successful=[];
NodeUnixSocketDockerEngine.prototype.inspect=async function(a,c){const result=await originalInspect.call(this,a,c);successful.push({engine:this,authority:{...a},existence:result.existence});return result;};
const selected=selectRecipe(fresh);
assert.ok(cap.readContainedTurnSelectedRouteAdmission(selected.route));
assert.equal(cap.readContainedTurnSelectedRouteAdmission({...selected.route}),undefined);
await fresh.preparation.engineIdentity(f.call());
assert.throws(()=>fresh.preparation.openLifecycle({...operationPolicy,memoryBytes:operationPolicy.memoryBytes+4096}));
fresh.preparation.openLifecycle(operationPolicy);
const secondBinding={...binding,operationId:'operation:second',attemptId:'attempt:second',custodyId:'custody:second'};
const second=makeRecipe(secondBinding); const selectedSecond=selectRecipe(second,secondBinding);
const secondNetwork=operationNetworkName({...netBinding,operationSha256:'4'.repeat(64)});
const secondPolicy={...operationPolicy,allowedNetworkName:secondNetwork};
const secondInput={...input,operationNonceSha256:'5'.repeat(64)};
const secondBody=encodeCreateRequest(secondInput,secondPolicy);const {HostConfig:secondHost,...secondConfig}=secondBody;
const secondAuthority={...authority,containerId:'6'.repeat(64),operationNonceSha256:secondInput.operationNonceSha256,
 createSpecificationSha256:canonicalJsonSha256({Name:containerName(secondInput.operationNonceSha256),Request:secondBody})};
containers.set(secondAuthority.containerId,{...wire,Id:secondAuthority.containerId,Name:'/'+containerName(secondInput.operationNonceSha256),Config:secondConfig,HostConfig:secondHost,State:{...wire.State,Pid:4243}});
await second.preparation.engineIdentity(f.call());second.preparation.openLifecycle(secondPolicy);
await assert.rejects(selected.route.engine.inspect(secondAuthority,f.call()),{code:'authority-conflict'});
await assert.rejects(selectedSecond.route.engine.inspect(authority,f.call()),{code:'authority-conflict'});
const first=retainDockerNativeBrokerRoute(cap.readContainedTurnSelectedRouteAdmission(selected.route));
const result=await first.routeAdmission.admit({authority,endpoint:{address:'172.30.0.1',port:18443},...f.call(),lifetimeMs:120000});
assert.equal(result.kind,'installed', 'operation-network container must install through the selected deployment inspector');
const secondAdmission=cap.readContainedTurnSelectedRouteAdmission(selectedSecond.route);
const secondResult=await secondAdmission.admit({authority:secondAuthority,endpoint:{address:'172.30.0.1',port:18443},...f.call(),lifetimeMs:120000});
assert.equal(secondResult.kind,'installed');
assert.equal((await selected.route.engine.inspect(authority,f.call())).existence,'present');
assert.equal((await selectedSecond.route.engine.inspect(secondAuthority,f.call())).existence,'present');
assert.throws(()=>selectRecipe(fresh));
assert.equal(result.firstWrite.reserve('request:first').consume(),true);
assert.equal(secondResult.firstWrite.reserve('request:second').consume(),true);
assert.equal(nominalInspections,0);
assert.equal(result.owner.revoke(),'closed');
assert.equal(secondResult.owner.revoke(),'closed');
assert.equal(await fresh.releaseAfterHostCleanup(f.call()),'released');
assert.equal(await second.releaseAfterHostCleanup(f.call()),'released');
containers.delete(authority.containerId);containers.delete(secondAuthority.containerId);
assert.equal(await first.routeAdmission.releaseAfterContainerRemoval(),'closed');
assert.equal(await secondAdmission.releaseAfterContainerRemoval(),'closed');
assert.equal(descriptors.size,0);
for(const expected of [authority,secondAuthority]) {
 const own=successful.filter(item=>item.authority.containerId===expected.containerId);
 assert.ok(own.length>=4);assert.equal(new Set(own.map(item=>item.engine)).size,1);
 assert.equal(own.at(-1).existence,'absent');for(const item of own){assert.deepEqual(item.authority,expected);}
}
assert.notEqual(successful.find(item=>item.authority.containerId===authority.containerId).engine,
 successful.find(item=>item.authority.containerId===secondAuthority.containerId).engine);
// A cutoff racing the asynchronous opening must not publish an installed lease.
const racingRecipe=makeRecipe();const racingSelected=selectRecipe(racingRecipe);
await racingRecipe.preparation.engineIdentity(f.call());racingRecipe.preparation.openLifecycle(operationPolicy);
containers.set(authority.containerId,{...wire,State:{...wire.State,Pid:4244}});
const beforeRace=BoundedUnixHttpClient.prototype.buffered;let racingCleanup;
BoundedUnixHttpClient.prototype.buffered=async function(r){
 if(r.path.includes('/containers/') && racingCleanup===undefined){racingCleanup=racingRecipe.releaseAfterHostCleanup(f.call());}
 return beforeRace.call(this,r);
};
const racingAdmission=cap.readContainedTurnSelectedRouteAdmission(racingSelected.route);
assert.deepEqual(await racingAdmission.admit({authority,...f.call(),endpoint:{address:'172.30.0.1',port:18443},lifetimeMs:120000}),{kind:'unsupported',reason:'owner'});
assert.equal(await racingCleanup,'released');
BoundedUnixHttpClient.prototype.buffered=beforeRace;
assert.ok(kernels.get('/proc/4244/ns/net').counts().transactions >= 2);
assert.equal(kernels.get('/proc/4244/ns/net').rules().filter(entry => entry.rule).length, 0);
containers.delete(authority.containerId);
assert.equal(await racingAdmission.releaseAfterContainerRemoval(),'closed');assert.equal(descriptors.size,0);
console.log('PASS cutoff during opening refuses publication, revokes the installed lease, and retains exact-authority historical removal');
const negativeRecipe=makeRecipe();
assert.throws(()=>selectRecipe({...negativeRecipe,route:{...negativeRecipe.route}}));
assert.throws(()=>selectRecipe({...negativeRecipe,route:new Proxy(negativeRecipe.route,{})}));
assert.throws(()=>selectRecipe({...negativeRecipe,preparation:{...negativeRecipe.preparation,openLifecycle(){}}}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,operationId:'other'}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,attemptId:'other'}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,custodyId:'other'}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,authorityVectorDigest:'other'}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,executionGenerationId:'other'}));
assert.throws(()=>selectRecipe(negativeRecipe,{...binding,hostBootId:'other'}));
assert.throws(()=>selectRecipe(makeRecipe(binding,{nft:{...pin,sha256:'f'.repeat(64)}})));
assert.throws(()=>selectRecipe(makeRecipe(binding,{enginePolicy:{...identityPolicy,memoryBytes:identityPolicy.memoryBytes+4096}})));
console.log('PASS actual nominal deployment selection rejects forged/proxy route, replaced lifecycle, cross operation/attempt/custody/authority/Host, mutated pins and policy');
const closedRecipe=makeRecipe();const closedSelected=selectRecipe(closedRecipe);await closedRecipe.releaseAfterHostCleanup(f.call());
const count=inspected.length;
assert.deepEqual(await cap.readContainedTurnSelectedRouteAdmission(closedSelected.route).admit({authority,...f.call(),endpoint:{address:'172.30.0.1',port:18443},lifetimeMs:120000}),{kind:'unsupported',reason:'owner'});
assert.equal(inspected.length,count);
assert.throws(()=>selectRecipe(makeRecipe(binding,{routeSubject:{}})));
const noPolicy=cap.createContainedTurnRouteEnforcement({qualificationTarget:target,binding,engine:bad,nsenter:pin,nft:pin});
assert.throws(()=>cap.bindContainedTurnRouteEnforcement(noPolicy,binding,makeRecipe()));
assert.throws(()=>selectRecipe({...makeRecipe(),route:{engine:good,nsenter:pin,nft:pin}}));
assert.throws(()=>{fresh.route.engine.inspect=good.inspect.bind(good);});
console.log('PASS nominal policy required, arbitrary Engine rejected, recipe inspector immutable, and source policy/pin/subject mutations detached');
console.log('PASS actual deployment -> nominal admission -> real route opener/owner: two independent operation policies, installed + first-write, same inspectors for readback/removal after cutoff; closed recipe cannot admit');
assert.equal(nominalInspections,0);
assert.ok(privilegeCalls >= 3);
console.log(JSON.stringify({nominalInspections,routeInspections:inspected.length,descriptorsRemaining:descriptors.size,scope:'Actual deployment selection, recipe, Engine, codec, admission, route opener and lease. Acknowledged authority, unrelated HTTP owners, journal/lifecycle storage and kernel effects are synthetic. No launch, provider, network, Docker, firewall or credentials.'}));

});
