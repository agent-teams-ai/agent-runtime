import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {after} from "node:test";
import {ids, openInput} from "./support/current-provider-owner-fixture.ts";
import {committedDispatchProofFixture} from "./support/committed-dispatch-proof-fixture.ts";
import {synthetic} from "./node-custody-http-reservation-fakes.ts";
export {deferred, tick} from "./node-custody-http-reservation-fakes.ts";
const {plan, workspace} = synthetic;
// Fixed, test-local substitutions, loaded before Core. Ordinary dist imports also
// work in the compiled package runner; the worker uses the supplied source hook.
const names = new Set([
  "private-host-custody-reservation.js", "host-custody-launch.js", "node-provider-process-custody-launch.js",
  "node-provider-process-custody-spawn-acknowledgement.js", "host-custody-evidence.js", "host-custody-private-root.js",
]);
const hook = registerHooks({resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("/host-custody/") && names.has(specifier.slice(specifier.lastIndexOf("/") + 1))) {
    return {url: new URL("./node-custody-http-reservation-fakes.ts", import.meta.url).href, shortCircuit: true};
  }
  return nextResolve(specifier, context);
}});
after(() => hook.deregister());

export const {NodeProviderProcessCustodyCore: Core} = await import(
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody-core.js");
export const {ContainedTurnKernelCustodyAdapter: Kernel} = await import(
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-adapter.js");

const closed = async () => true;

export const startInput = (signal = new AbortController().signal) => ({
  arguments: [...plan.arguments], command: plan.executablePath, cwd: "/proc/self/fd/4",
  environment: {...plan.environment} as Record<string, string | undefined>, signal,
});

export const fixture = () => {
  synthetic.reset();
  let close = closed;
  const options = {hostLifecycleGeneration: "synthetic-lifecycle-generation", launchPlans: {resolve: async () => plan},
    residueAuthorityFactory: {create: async () => ({close: () => close(), proveEmpty: async () => "empty", killAll: async () => true})}};
  const profile = {containmentProfile: "strict-linux-cgroup-v2", platform: "linux", residueAuthorityFactory: options.residueAuthorityFactory};
  const core = new Core(options as never, profile as never);
  const identity = ids("codex", "http-reservation");
  const input = openInput(identity, "codex", {provider: "codex", adapterRevision: "adapter:test",
    binaryRevision: plan.binaryRevision, capabilityManifestRevision: "manifest:test"});
  const reservation = {attemptId: identity.attemptId, operationId: identity.operationId, intentMode: "analysis",
    providerBinding: {provider: "codex", adapterRevision: "adapter:test", binaryRevision: plan.binaryRevision,
      capabilityManifestRevision: "manifest:test", credentialBindingDigest: "credential:test", providerRouteRef: "route:test"},
    workspaceRef: "/synthetic/workspace", launchPlan: plan,
    workspaceAuthority: {canonicalPath: "/synthetic/workspace", descriptorPath: "/synthetic/pin", identity: {...workspace, mountId: "synthetic-mount"}}};
  const preparation = Core.httpPreparation(core)!;
  assert.equal(Core.httpPreparation(core), preparation);
  const signal = new AbortController();
  const proofFor = (opened: any, overrides = {}) => committedDispatchProofFixture(input, opened, overrides);
  const handoff = (custodyRef: string) => ({underlyingCustodyRef: custodyRef, signal: signal.signal,
    committedDispatchProof: proofFor({hostBootId: "host-boot:kernel", hostInstanceId: "host-instance:kernel",
      hostCustodyProof: {proofId: "proof:kernel"}})});
  return {...synthetic, core, identity, input, options, profile, reservation, preparation, signal, proofFor, handoff,
    reserve: () => core.reserve(reservation as never),
    start: (custodyRef: string, startSignal = new AbortController().signal) => core.start(custodyRef,
      {arguments: plan.arguments, command: plan.executablePath, cwd: "/proc/self/fd/4", environment: plan.environment, signal: startSignal}),
    closeWith: (next: () => Promise<boolean>) => {close = next;},
  };
};
