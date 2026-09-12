import type { LiveCustody } from "./node-provider-process-custody-state.js";
import { readNodeCustodyHttpHandoff, type NodeCustodyHttpPreparation, type NodeCustodyHttpLifetime } from "./node-provider-process-custody-http-reservation.js";
import { assertDarwinNativeExecutionClaim, assertRetainedDarwinNativeHttpExecutionAuthority, bindRetainedDarwinNativeHttpLaunch } from "./darwin-attempt-owner-selection.js";
import { consumeNativeHostCustodyExecutionLease } from "./native-host-custody-workspace-authority.js";

/** Own preparation identities for the core's retained reservation map. */
export function createNodeCustodyHttpPreparation(byRef: ReadonlyMap<string, LiveCustody>): NodeCustodyHttpPreparation {
  const preparations = new WeakMap<NodeCustodyHttpLifetime, LiveCustody>();
  const capability: NodeCustodyHttpPreparation = Object.freeze({
    acquire(input: Parameters<NodeCustodyHttpPreparation["acquire"]>[0]) {
      if (this !== capability) {throw new TypeError("Host Custody HTTP preparation receiver conflicts");}
      const handoff = readNodeCustodyHttpHandoff(input);
      const live = byRef.get(handoff.underlyingCustodyRef);
      if (live === undefined) {throw new TypeError("Host Custody HTTP reservation is unavailable");}
      const lifetime = live.httpReservation.acquire(live, handoff);
      preparations.set(lifetime, live);
      return lifetime;
    },
    consumeDarwinNativeExecution(lifetime: Parameters<NodeCustodyHttpPreparation["consumeDarwinNativeExecution"]>[0],
      authority: Parameters<NodeCustodyHttpPreparation["consumeDarwinNativeExecution"]>[1]) {
      const live = preparations.get(lifetime);
      if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live ||
          live.nativeExecutionLease === undefined || live.nativeWorkspaceAuthority === undefined) {
        throw new TypeError("Host Custody native execution reservation conflicts");
      }
      live.httpReservation.assertPreparation(lifetime);
      assertDarwinNativeExecutionClaim(live.nativeExecutionLease, lifetime.committedDispatchProof);
      assertRetainedDarwinNativeHttpExecutionAuthority(authority, live.nativeExecutionLease);
      const lease = consumeNativeHostCustodyExecutionLease(live.nativeWorkspaceAuthority, live.nativeExecutionLease);
      live.httpReservation.retainNativeExecution(lease);
      return lease;
    },
    async bindDarwinNativeFinalLaunch(
      ...[lifetime, authority, lease, material, port, launch]: Parameters<NodeCustodyHttpPreparation["bindDarwinNativeFinalLaunch"]>
    ) {
      const live = preparations.get(lifetime);
      if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live ||
          live.nativeExecutionLease !== lease || live.launchBinding.view.readFinal() !== launch) {
        throw new TypeError("Host Custody native final launch binding conflicts");
      }
      await bindRetainedDarwinNativeHttpLaunch(authority, lease, {launch, binding: live.launchBinding, material, port});
    },
    prepareResources(lifetime: NodeCustodyHttpLifetime, input: Parameters<NodeCustodyHttpPreparation["prepareResources"]>[1]) {
      const live = preparations.get(lifetime);
      if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
        throw new TypeError("Host Custody HTTP preparation identity conflicts");
      }
      return live.httpReservation.prepareResources(lifetime, input);
    },
    retainDarwinRoute(lifetime: NodeCustodyHttpLifetime, route: Parameters<NodeCustodyHttpPreparation["retainDarwinRoute"]>[1]) {
      const live = preparations.get(lifetime);
      if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
        throw new TypeError("Host Custody Darwin route preparation conflicts");
      }
      live.httpReservation.retainDarwinRoute(live, lifetime, route);
    },
    finalize(lifetime: NodeCustodyHttpLifetime) {
      const live = preparations.get(lifetime);
      if (this !== capability || live === undefined || byRef.get(live.custodyRef) !== live) {
        throw new TypeError("Host Custody HTTP preparation identity conflicts");
      }
      return live.launchBinding.bind(live, lifetime);
    },
  });
  return capability;
}
