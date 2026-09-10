// SYNTHETIC ONLY: no native syscall, descriptor, prepared claim or qualification.
import { createHash } from "node:crypto";
const selections = new WeakMap<object, any>();
const observations = new WeakMap<object, any>();
const materials = new WeakMap<object, any>();
const owners = new WeakMap<object, object>();
const rejectingOwners = new WeakSet<object>();
export const syntheticFacts = () => ({operationId: "synthetic-operation", generation: "synthetic-generation", leasedUid: 501,
  privateRoot: {path: "/synthetic/private", dev: 1n, ino: 2n, uid: 501, mode: 0o40700},
  codexHome: {path: "/synthetic/private/home", dev: 1n, ino: 3n, uid: 501, mode: 0o40700},
  tmpDir: {path: "/synthetic/private/tmp", dev: 1n, ino: 4n, uid: 501, mode: 0o40700},
  workspace: {path: "/synthetic/workspace", dev: 1n, ino: 5n, uid: 501, mode: 0o40700}});
export function issueSyntheticSelection(facts = syntheticFacts(), mutateMaterial = (_: any) => {}) {
  const selection = Object.freeze({}); const observation = Object.freeze({});
  const state = {facts, observation, current: true, installed: false, mutateMaterial};
  selections.set(selection, state); observations.set(observation, state); return selection;
}
export function issueSyntheticOwner(selection: object, rejectAfterCallback = false) {
  const owner = Object.freeze({withLaunchAuthority() {throw new Error("synthetic native descriptor fallback");}});
  owners.set(owner, selection); if (rejectAfterCallback) {rejectingOwners.add(owner);} return owner;
}
export const isNodeContainedTurnNativeWorkspaceOwner = (value: object) => owners.has(value);
export async function withNodeContainedTurnNativeWorkspaceSelection(owner: object, _ids: unknown, consume: any) {
  const selection = owners.get(owner); if (!selection) {throw new TypeError("synthetic owner rejected");}
  const result = await consume(selection);
  if (rejectingOwners.has(owner)) {throw new Error("synthetic owner failure after callback");}
  return result;
}
export async function readDarwinNativeLaunchObservation(selection: object) {
  const state = selections.get(selection); if (!state || !state.current) {throw new TypeError("synthetic selection rejected");}
  return state.observation;
}
export function inspectDarwinNativeLaunchObservation(observation: object) {
  const state = observations.get(observation); if (!state) {throw new TypeError("synthetic observation rejected");}
  return state.facts;
}
export function assertDarwinNativeLaunchObservationCurrent(observation: object) {
  const state = observations.get(observation); if (!state?.current) {throw new TypeError("synthetic observation expired");}
}
export function expireSyntheticSelection(selection: object) {selections.get(selection).current = false;}
export function advanceSyntheticGenerationOnInstall(selection: object) {selections.get(selection).advanceOnInstall = true;}
export async function installDarwinNativeCodexMaterial(selection: object, input: any) {
  let state = selections.get(selection); if (!state?.current || state.installed) {throw new TypeError("synthetic install rejected");}
  state.installed = true;
  if (state.advanceOnInstall) {
    state.current = false;
    state = {...state, current: true, observation: Object.freeze({}), facts: {...state.facts, generation: "synthetic-installed-generation"}};
    selections.set(selection, state); observations.set(state.observation, state);
  }
  const fact = (name: string, bytes: Uint8Array, mode: number, ino: bigint) => ({path: `${state.facts.codexHome.path}/${name}`,
    dev: 1n, ino, uid: state.facts.leasedUid, mode: 0o100000 | mode, nlink: 1, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")});
  const facts = {observation: state.observation, installationId: input.installationId,
    config: fact("config.toml", input.config, 0o600, 6n), catalog: fact("models.json", input.catalog, 0o600, 7n),
    installation: fact("installation_id", Buffer.from(input.installationId), 0o644, 8n)};
  state.mutateMaterial(facts); const material = Object.freeze({}); materials.set(material, {facts, state}); return material;
}
export function inspectDarwinNativeCodexMaterial(material: object) {
  const held = materials.get(material); if (!held) {throw new TypeError("synthetic material rejected");} return held.facts;
}
export function assertDarwinNativeCodexMaterialCurrent(material: object) {
  const held = materials.get(material); if (!held?.state.current) {throw new TypeError("synthetic material expired");}
}
