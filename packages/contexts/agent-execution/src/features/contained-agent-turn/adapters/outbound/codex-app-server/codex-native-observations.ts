import {
  inspectDarwinNativeLaunchObservation, assertDarwinNativeLaunchObservationCurrent,
  inspectDarwinNativeCodexMaterial, assertDarwinNativeCodexMaterialCurrent,
  type DarwinNativeCodexMaterial, type DarwinNativeLaunchObservation,
} from "../host-custody/contained-turn-kernel-custody-entrypoint.js";
import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";
import type { CodexNativeBrokerRecipe } from "./codex-native-broker-recipe.js";

const nativeObservations = new WeakMap<CodexAppServerPermissionBoundary, DarwinNativeLaunchObservation>();
const nativeOriginals = new WeakMap<CodexAppServerPermissionBoundary, ReturnType<typeof inspectDarwinNativeLaunchObservation>>();
/** Only authenticated installed material can advance a boundary generation. */
export const acceptCodexDarwinNativeMaterialObservation = (
  boundary: CodexAppServerPermissionBoundary, material: DarwinNativeCodexMaterial,
): void => {
  const original = nativeOriginals.get(boundary);
  if (original === undefined) {throw new TypeError("Native Codex boundary provenance rejected");}
  const installed = inspectDarwinNativeCodexMaterial(material);
  assertDarwinNativeCodexMaterialCurrent(material);
  const next = inspectDarwinNativeLaunchObservation(installed.observation);
  if (next.operationId !== original.operationId || next.leasedUid !== original.leasedUid ||
      (["privateRoot", "codexHome", "tmpDir", "workspace"] as const).some(key => {
        const a = original[key]; const b = next[key];
        return a.path !== b.path || a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode;
      })) {throw new TypeError("Native Codex material changed original roots");}
  assertDarwinNativeLaunchObservationCurrent(installed.observation);
  nativeObservations.set(boundary, installed.observation);
};
/** Same-object lookup precedes observation inspection; this is lifetime validation,
 * not fresh OS readback. Native START must revalidate descriptors atomically. */
export const codexDarwinNativeLaunchObservation = (
  boundary: CodexAppServerPermissionBoundary,
): DarwinNativeLaunchObservation | undefined => {
  const observation = nativeObservations.get(boundary);
  if (observation !== undefined) {assertDarwinNativeLaunchObservationCurrent(observation);}
  return observation;
};

export const retainCodexDarwinNativeLaunchObservation = (
  boundary: CodexAppServerPermissionBoundary, observation: DarwinNativeLaunchObservation,
): void => {
  nativeObservations.set(boundary, observation);
  nativeOriginals.set(boundary, inspectDarwinNativeLaunchObservation(observation));
};

// Borrowed synchronous observation readers; installation remains owned by broker files.
const materialReaders = new WeakMap<CodexNativeBrokerRecipe, () => readonly string[]>();
export const retainCodexDarwinNativeMaterialReader = (recipe: CodexNativeBrokerRecipe, reader: () => readonly string[]): void => {
  materialReaders.set(recipe, reader);
};
export const codexDarwinNativeMaterialIdentity = (recipe: CodexNativeBrokerRecipe): readonly string[] | undefined =>
  materialReaders.get(recipe)?.();
