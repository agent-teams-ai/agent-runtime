import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import {registerHooks} from "node:module";
import {after, test} from "node:test";
// Test-local native seam. No provider or native launch is performed.
import * as native from "./darwin-codex-effect-custody-fixture.mjs";
const {fixture} = native;
const fakeUrl = new URL("./darwin-codex-effect-custody-fixture.mjs", import.meta.url).href;
const hooks = registerHooks({resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/darwin-codex-effect-custody-owner.js") && specifier.endsWith("/contained-turn-kernel-custody-entrypoint.js")) {
    return {shortCircuit: true, url: fakeUrl};
  }
  return nextResolve(specifier, context);
}});
after(() => hooks.deregister());
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
  for(const phase of ["updated","completed","terminal"]){assert.equal(f.owner.authority.admit(request(f,{phase,priorAdmission:token})),token);}
  f.owner.cutoff();f.revoke();
  assert.equal(f.owner.authority.admit(request(f,{phase:"terminal",priorAdmission:token})),token);
  assert.equal(f.owner.authority.admit(request(f,{itemId:"new"})),undefined);
  assert.equal(f.owner.authority.admit(request(f,{itemType:"commandExecution",priorAdmission:token})),undefined);
});
test("new items are bounded and require current native authority independent of endpoints", () => {
  const f=bound();
  for(const override of [{itemId:""},{itemId:"x".repeat(1025)},{itemType:"other"},{phase:"other"},{effectId:"other"},{priorAdmission:{}}]){assert.equal(f.owner.authority.admit(request(f,override)),undefined);}
  for(let i=0;i<4096;i++){assert.ok(f.owner.authority.admit(request(f,{itemId:String(i)})));}
  assert.equal(f.owner.authority.admit(request(f,{itemId:"overflow"})),undefined);
  const revoked=bound();revoked.revoke();assert.equal(revoked.owner.authority.admit(request(revoked,{endpointObservations:[{path:"/workspace"}]})),undefined);
});
test("cutoff before binding permanently rejects it",()=>{
  const f=fixture(),owner=create();owner.cutoff();assert.throws(()=>owner.bind(f.lease,f.proof,f.execution));
});



test("command execution has a distinct token and successful binding cannot be reused",()=>{
  const f=bound(), file=f.owner.authority.admit(request(f));
  const command=f.owner.authority.admit(request(f,{itemId:"command",itemType:"commandExecution"}));
  assert.ok(command);assert.notEqual(command,file);
  assert.equal(f.owner.authority.admit(request(f,{itemId:"command",itemType:"commandExecution",phase:"completed",priorAdmission:command})),command);
  assert.throws(()=>f.owner.bind(f.lease,f.proof,f.execution),/consumed/);
});

test("hostile execution getters cannot mutate the authenticated claim or lease",()=>{
  const f=fixture(),owner=create();let invoked=false;
  const hostile={...f.execution,get effectId(){invoked=true;f.proof.effectId="forged";f.revoke();return "forged";}};
  assert.throws(()=>owner.bind(f.lease,f.proof,hostile),/own data/);
  assert.equal(invoked,false);assert.equal(f.proof.effectId,"effect");
  assert.equal(owner.authority.admit(request(f)),undefined);
});
test("execution proxies and extra/accessor fields are rejected without invoking traps",()=>{
  for(const kind of ["proxy","extra","symbol","prototype"]) {
    const f=fixture(),owner=create();let invoked=false;
    const hostile=kind==="proxy"?new Proxy(f.execution,{ownKeys(){invoked=true;f.proof.effectId="forged";return Reflect.ownKeys(f.execution);},getPrototypeOf(){invoked=true;return Object.prototype;}})
      :kind==="extra"?{...f.execution,extra:true}:kind==="symbol"?{...f.execution,[Symbol()]:true}:Object.create(f.execution);
    assert.throws(()=>owner.bind(f.lease,f.proof,hostile),/inert data|own data/);
    assert.equal(invoked,false);assert.equal(f.proof.effectId,"effect");assert.equal(owner.authority.admit(request(f)),undefined);
  }
});
test("committed proof proxies are rejected before comparator traps",()=>{
  const f=fixture();let invoked=false;
  const proof=new Proxy(f.proof,{getPrototypeOf(){invoked=true;return Object.prototype;}});
  assert.throws(()=>create().bind(f.lease,proof,f.execution),/inert data/);assert.equal(invoked,false);
});


test("terminal disposal removes abort listeners and releases prior admissions", async()=>{
  const f=bound(), claim=new AbortController(), shutdown=new AbortController();
  const before=native.counters.abortCallbacks;
  f.owner.observeAbort(claim.signal);f.owner.observeAbort(shutdown.signal);
  assert.equal(getEventListeners(claim.signal,"abort").length,1);
  const token=f.owner.authority.admit(request(f));assert.ok(token);
  f.owner.dispose();f.owner.dispose();
  assert.equal(getEventListeners(claim.signal,"abort").length,0);
  assert.equal(getEventListeners(shutdown.signal,"abort").length,0);
  claim.abort();shutdown.abort();assert.equal(native.counters.abortCallbacks,before);
  assert.equal(f.owner.authority.admit(request(f,{priorAdmission:token})),undefined);
  assert.throws(()=>f.owner.observeAbort(new AbortController().signal),/disposed/);
});
