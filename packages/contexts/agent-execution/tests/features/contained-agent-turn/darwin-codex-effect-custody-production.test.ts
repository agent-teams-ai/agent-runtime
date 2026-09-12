import assert from "node:assert/strict";
import {getEventListeners} from "node:events";
import {test} from "node:test";
import {fixture} from "./darwin-codex-effect-custody-fixture.mjs";
const request = f => ({...f.execution,itemId:"item",itemType:"fileChange",phase:"started",endpointObservations:[]});
test("production native registry rejects fabricated leases without launching anything", async () => {
  const actual = await import("../../../dist/features/contained-agent-turn/composition/darwin-codex-effect-custody-owner.js");
  const f=fixture(), owner=actual.createDarwinCodexEffectCustodyOwner();
  assert.throws(()=>owner.bind(f.lease,f.proof,f.execution),/foreign native execution lease/);
  assert.equal(owner.authority.admit(request(f)),undefined);
});
test("failed preparation disposal removes the genuine production abort subscription",async()=>{
  const actual=await import("../../../dist/features/contained-agent-turn/composition/darwin-codex-effect-custody-owner.js");
  const owner=actual.createDarwinCodexEffectCustodyOwner(), controller=new AbortController();
  owner.observeAbort(controller.signal);assert.equal(getEventListeners(controller.signal,"abort").length,1);
  owner.dispose();assert.equal(getEventListeners(controller.signal,"abort").length,0);controller.abort();
});
