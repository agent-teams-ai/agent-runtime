import type {DriverFactory} from "@agent-teams/agent-execution/interactive-contracts";
import type {SessionRef} from "../../domain/session-host.js";

/** Canonical provider SPI stays at this adapter boundary; old-generation commands cannot reach it. */
export function bindProviderGeneration(factory: DriverFactory, current: (ref: SessionRef) => boolean, retain: (ref: SessionRef) => void): DriverFactory {
  return {open: async config => {
    retain(config);
    const opened = await factory.open(config);
    const allowed = (): boolean => current(config);
    const stale = {ok: false as const, code: "stale" as const};
    const driver = opened.driver;
    return {...opened, driver: {
      sessionRef: driver.sessionRef,
      submit: input => allowed() ? driver.submit(input) : Promise.resolve(stale),
      observe: () => allowed() ? driver.observe() : (async function* () {})(),
      respondToInteraction: (ref, answer) => allowed() ? driver.respondToInteraction(ref, answer) : stale,
      interrupt: operation => allowed() ? driver.interrupt(operation) : Promise.resolve(stale),
      checkReadiness: () => allowed() ? driver.checkReadiness() : Promise.resolve(stale),
      checkpoint: () => allowed() ? driver.checkpoint() : stale,
      close: () => driver.close(),
    }};
  }};
}
