import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {after, test} from "node:test";
// Test-local native seam. No provider or native launch is performed.
const fake = `
const states = new WeakMap();
export const fixture = () => {
 const proof = {operationId:'op',attemptId:'attempt',custodyId:'custody',effectId:'effect',workspaceId:'ws',executionGenerationId:'gen',provider:'codex'};
 const directory = (path, ino) => ({path,ino,dev:1n,uid:501,mode:448});
 const observation = {operationId:'op',leasedUid:501,privateRoot:directory('/private',1n),workspace:directory('/workspace',2n)};
 const facts = {prepared:proof,observation,custodyRef:'native',hostGenerationBinding:'a'.repeat(64)};
 const lease = {}; const state = {proof,facts,current:true}; states.set(lease,state);
 return {lease,proof,facts,observation,revoke(){state.current=false},execution:{operationId:'op',attemptId:'attempt',custodyRef:'custody',effectId:'effect',workspaceRef:'/workspace'}};
};
export const inspectDarwinNativeExecutionLease = lease => {const s=states.get(lease);if(!s?.current)throw Error('foreign or revoked');return s.facts};
export const assertDarwinNativeExecutionClaim = (lease, proof) => {if(states.get(lease)?.proof!==proof)throw Error('foreign claim')};
export const inspectDarwinNativeLaunchObservation = observation => observation;
`;
const fakeUrl = `data:text/javascript,${encodeURIComponent(fake)}`;
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/darwin-codex-effect-custody-owner.js") && specifier.endsWith("/contained-turn-kernel-custody-entrypoint.js")) {
    return {shortCircuit: true, url: fakeUrl};
  }
  return nextResolve(specifier, context);
}});
after(() => hooks.deregister());
const {fixture} = await import(fakeUrl);
const {createDarwinCodexEffectCustodyOwner: create, isDarwinCodexEffectCustodyOwner: issued} = await import(
  "../../../dist/features/contained-agent-turn/composition/darwin-codex-effect-custody-owner.js");
const request = (f, overrides = {}) => ({...f.execution,itemId:"item",itemType:"fileChange",phase:"started",endpointObservations:[],...overrides});
const bound = () => {const f=fixture(), owner=create();owner.bind(f.lease,f.proof,f.execution);return {...f,owner};};

test("unbound admission, forged owner/claim and repeated binding are rejected", () => {
  const f=fixture(),owner=create(); assert.equal(owner.authority.admit(request(f)),undefined);
  assert.equal(issued(owner),true); assert.equal(issued({...owner}),false);
  assert.throws(()=>owner.bind({},f.proof,f.execution));
  assert.throws(()=>owner.bind(f.lease,f.proof,f.execution),/consumed/);
  assert.throws(()=>create().bind(f.lease,{...f.proof},f.execution));
});
test("all execution identity fields and native directory custody must match", () => {
  for(const key of Object.keys(fixture().execution)) {
    const f=fixture();assert.throws(()=>create().bind(f.lease,f.proof,{...f.execution,[key]:"foreign"}));
  }
  for(const mutate of [f=>{f.observation.privateRoot.ino=2n},f=>{f.observation.workspace.mode=511},f=>{f.facts.hostGenerationBinding=""}]) {
    const f=fixture();mutate(f);assert.throws(()=>create().bind(f.lease,f.proof,f.execution));
  }
});
test("stable opaque tokens require exact prior continuity including after cutoff", () => {
  const f=bound(),token=f.owner.authority.admit(request(f));assert.ok(token);
  assert.equal(f.owner.authority.admit(request(f)),undefined);
  assert.equal(f.owner.authority.admit(request(f,{priorAdmission:{}})),undefined);
  for(const phase of ["updated","completed","terminal"])assert.equal(f.owner.authority.admit(request(f,{phase,priorAdmission:token})),token);
  f.owner.cutoff();f.revoke();
  assert.equal(f.owner.authority.admit(request(f,{phase:"terminal",priorAdmission:token})),token);
  assert.equal(f.owner.authority.admit(request(f,{itemId:"new"})),undefined);
  assert.equal(f.owner.authority.admit(request(f,{itemType:"commandExecution",priorAdmission:token})),undefined);
});
test("new items are bounded and require current native authority independent of endpoints", () => {
  const f=bound();
  for(const override of [{itemId:""},{itemId:"x".repeat(1025)},{itemType:"other"},{phase:"other"},{effectId:"other"},{priorAdmission:{}}])assert.equal(f.owner.authority.admit(request(f,override)),undefined);
  for(let i=0;i<4096;i++)assert.ok(f.owner.authority.admit(request(f,{itemId:String(i)})));
  assert.equal(f.owner.authority.admit(request(f,{itemId:"overflow"})),undefined);
  const revoked=bound();revoked.revoke();assert.equal(revoked.owner.authority.admit(request(revoked,{endpointObservations:[{path:"/workspace"}]})),undefined);
});
test("cutoff before binding permanently rejects it",()=>{
  const f=fixture(),owner=create();owner.cutoff();assert.throws(()=>owner.bind(f.lease,f.proof,f.execution));
});

test("production native registry rejects fabricated leases without launching anything", async () => {
  const actual = await import("../../../dist/features/contained-agent-turn/composition/darwin-codex-effect-custody-owner.js?production-registry");
  const f=fixture(), owner=actual.createDarwinCodexEffectCustodyOwner();
  assert.throws(()=>owner.bind(f.lease,f.proof,f.execution),/foreign native execution lease/);
  assert.equal(owner.authority.admit(request(f)),undefined);
});

test("command execution has a distinct token and successful binding cannot be reused",()=>{
  const f=bound(), file=f.owner.authority.admit(request(f));
  const command=f.owner.authority.admit(request(f,{itemId:"command",itemType:"commandExecution"}));
  assert.ok(command);assert.notEqual(command,file);
  assert.equal(f.owner.authority.admit(request(f,{itemId:"command",itemType:"commandExecution",phase:"completed",priorAdmission:command})),command);
  assert.throws(()=>f.owner.bind(f.lease,f.proof,f.execution),/consumed/);
});
