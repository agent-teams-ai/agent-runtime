// TEST ONLY. Explicit disposable-host opt-in; importing this module runs no commands.
import {createLinuxCodexLiveAdminFirewall, type ExpectedOwnedNetwork, type FirewallCommand}
  from "./linux-codex-live-admin-firewall.ts";
import {dockerHttpOperationNetworkRecipe} from
  "@agent-teams/agent-execution/composition";
import type {LinuxCodexNodeRecipeSelection} from "../../../dist/composition/linux-codex-node-recipe.js";

export type LinuxCodexLiveFirewallPins = Readonly<{
  command: FirewallCommand;
  hostEngine: ExpectedOwnedNetwork["hostEngine"];
  daemonId: string;
  socketPath: string;
}>;

/** The private resource owner supplies retained allocation and container metadata
 * before open. CLI readback is compared with those pins; it issues no custody proof. */
export function createLinuxCodexLiveFirewallWiring(pins: LinuxCodexLiveFirewallPins):
  NonNullable<LinuxCodexNodeRecipeSelection["decorateListener"]> {
  const command = pins.command;
  const host = structuredClone({hostEngine: pins.hostEngine, daemonId: pins.daemonId, socketPath: pins.socketPath});
  if (!/^\/[\w/.-]+$/u.test(host.socketPath) || !host.daemonId) {throw new TypeError("Pinned local daemon required");}
  return (listener, subject, context) => {
    const retained = structuredClone(context);
    if (retained.container === undefined) {throw new TypeError("Retained provider container required");}
    const recipe = dockerHttpOperationNetworkRecipe(subject);
    const firewall = createLinuxCodexLiveAdminFirewall(command);
    let opening: Promise<unknown> | undefined;
    let closing = false;
    let cleanup: ReturnType<typeof listener.close> | undefined;
    const close: typeof listener.close = () => {
      closing = true;
      if (cleanup !== undefined) {return cleanup;}
      cleanup = (async () => {
        await opening?.catch(() => {});
        // The existing V4 coordinator owns this call and its ordering. Neither
        // abort nor an open failure independently releases the listener/network.
        const closed = await listener.close();
        const removed = await firewall.cleanup();
        return {state: closed.state === "closed" && removed === "removed" ? "closed" : "unknown"} as const;
      })().catch(() => ({state: "unknown" as const})).finally(() => {cleanup = undefined;});
      return cleanup;
    };
    return Object.freeze({...listener, close, open(...args: Parameters<typeof listener.open>) {
      if (opening !== undefined || closing) {return Promise.reject(new Error("Test listener admission closed"));}
      const work = (async () => {
        const opened = await listener.open(...args);
        if (closing || args[1].signal.aborted) {throw new Error("Test listener admission closed");}
        await firewall.allow(opened.address, {...host, binding: recipe.binding,
          networkName: recipe.name, ...retained}, args[1].signal);
        if (closing || args[1].signal.aborted) {throw new Error("Test listener admission closed");}
        return Object.freeze({...opened, close});
      })();
      opening = work;
      return work;
    }});
  };
}
