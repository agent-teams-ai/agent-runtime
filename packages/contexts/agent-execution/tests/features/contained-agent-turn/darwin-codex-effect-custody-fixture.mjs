
import {addAbortListener} from 'node:events';
export const counters = {abortCallbacks: 0};
export const hostHttpAbortOperations = {
 subscribe(signal, callback) {return addAbortListener(signal, () => {counters.abortCallbacks++; callback()})},
 aborted(signal) {return signal.aborted}, remove(subscription) {subscription[Symbol.dispose]()}
};
const states = new WeakMap();
export const fixture = () => {
 const proof = {operationId:'op',attemptId:'attempt',custodyId:'custody',effectId:'effect',workspaceId:'ws',executionGenerationId:'gen',provider:'codex'};
 const observation = {operationId:'op',leasedUid:501,privateRoot:directory('/private',1n),workspace:directory('/workspace',2n)};
 const facts = {prepared:proof,observation,custodyRef:'native',hostGenerationBinding:'a'.repeat(64)};
 const lease = {}; const state = {proof,facts,current:true}; states.set(lease,state);
 return {lease,proof,facts,observation,revoke(){state.current=false},execution:{operationId:'op',attemptId:'attempt',custodyRef:'custody',effectId:'effect',workspaceRef:'/workspace'}};
};
export const inspectDarwinNativeExecutionLease = lease => {const s=states.get(lease);if(!s?.current){throw Error('foreign or revoked');}return s.facts};
export const assertDarwinNativeExecutionClaim = (lease, proof) => {if(states.get(lease)?.proof!==proof){throw Error('foreign claim')}};
export const inspectDarwinNativeLaunchObservation = observation => observation;
const directory = (path, ino) => ({path,ino,dev:1n,uid:501,mode:448});
