import type {TestContext} from "node:test";
import {fixture as drainFixture} from "./docker-drain-stop-fixture.ts";
import {engineCall, createInput, owner} from "./docker-host-custody-lifecycle-fixture.ts";
import {createDockerHostCustodyLifecycle} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";

export {engineCall, createInput, digest, owner} from "./docker-host-custody-lifecycle-fixture.ts";
export {deferred, initOptions, providerExec, tick} from "./docker-drain-stop-fixture.ts";

/** Every invocation allocates its own disposable directory and memory Engine/channel. */
export const fixture = async (t: TestContext) => {
  const f = await drainFixture(t);
  const restart = () => createDockerHostCustodyLifecycle({engine: f.engine, journalStorage: f.storage,
    journalLimits: {maxJournalFiles: 1}, residue: {async proveEmpty() {f.events.push("residue"); return f.controls.residue;}}});
  const lifecycle = restart();
  const launch = () => lifecycle.launch({call: engineCall(), create: createInput(f.root), owner});
  const launched = await launch();
  const resolver = {async resolve() {return {authority: launched.authority, call: engineCall(), create: createInput(f.root)};}};
  return {...f, launch, lifecycle, launched, restart, resolver, read: () => lifecycle.observeLaunch(launched),
    contain: () => lifecycle.contain({...launched, call: engineCall()})};
};
