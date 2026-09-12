import {
  readDarwinNativeLaunchObservation, inspectDarwinNativeLaunchObservation,
  installDarwinNativeCodexMaterial, inspectDarwinNativeCodexMaterial, assertDarwinNativeCodexMaterialCurrent,
  inspectDarwinNativeExecutionLease,
  type DarwinNativeWorkspaceSelection, type DarwinNativeExecutionLease, type DarwinNativeCodexMaterial,
} from "../host-custody/contained-turn-kernel-custody-entrypoint.js";
import { validateCodexDirectoryIdentity } from "./codex-app-server-permission-boundary.js";
import { codexDarwinNativeLaunchObservation, acceptCodexDarwinNativeMaterialObservation, retainCodexDarwinNativeMaterialReader } from "./codex-native-observations.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { capturePathLineage, openStablePath, pathLineagesEqual } from "@agent-teams/filesystem-custody/composition";
import {
  darwinCodexInstallationMaterial, CODEX_NATIVE_CATALOG_BYTES, CODEX_NATIVE_CATALOG_SHA256,
  codexNativeBrokerBoundary, renderCodexNativeBrokerConfig,
  type CodexNativeBrokerRecipe,
} from "./codex-native-broker-recipe.js";

export interface CodexNativeBrokerFiles {
  readonly kind: "codex-native-broker-prepared-files/v1";
}
interface PreparedFiles {
  readonly recipe: CodexNativeBrokerRecipe;
  readonly observations: readonly Readonly<{ path: string; stats: BigIntStats }>[];
}
const prepared = new WeakMap<CodexNativeBrokerFiles, PreparedFiles>();
const rejected = (): TypeError => new TypeError("Codex native broker files rejected");
const assertEmptyNativeState = (home: string, recipe: CodexNativeBrokerRecipe): void => {
  const entries = readdirSync(home).toSorted();
  const expected = darwinCodexInstallationMaterial(recipe) === undefined ? ["config.toml", "models.json"] : ["config.toml", "installation_id", "models.json"];
  if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {throw rejected();}
};
const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

const observeFile = async (home: string, path: string, expected: { size: number; sha256: string }) =>
  openStablePath(path, path, async opened => {
    const stats = opened.stats;
    if (stats.size !== BigInt(expected.size) || (stats.mode & 0o077n) !== 0n
      || typeof process.getuid !== "function" || stats.uid !== BigInt(process.getuid())) {throw rejected();}
    const before = await capturePathLineage(path, home);
    const bytes = Buffer.alloc(expected.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await opened.handle.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) {break;}
      count += read.bytesRead;
    }
    if (count !== expected.size || createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== expected.sha256
      || !same(stats, await opened.handle.stat({ bigint: true }))
      || !pathLineagesEqual(before, await capturePathLineage(path, home))) {throw rejected();}
    return Object.freeze({ path, stats });
  }, { custodyBoundary: { absolutePath: home, canonicalPath: home } });

/** Explicit preparation only. The Host allocates an isolated home and installs
 * the renderer's exact TOML plus pinned upstream catalog before calling this.
 * Never reads auth state. Proves sampled file bytes/identity, not subsequent
 * native opens or hostile same-UID exclusion; the future Host binder owns that.
 */
export const prepareCodexNativeBrokerFiles = async (recipe: CodexNativeBrokerRecipe): Promise<CodexNativeBrokerFiles> => {
  const boundary = codexNativeBrokerBoundary(recipe);
  if (codexDarwinNativeLaunchObservation(boundary) !== undefined) {
    const files = nativeRecipes.get(recipe);
    if (files === undefined) {throw rejected();}
    validateCodexNativeBrokerFiles(files, recipe);
    return files;
  }
  try {
    validateCodexDirectoryIdentity("codexHome", boundary.codexHomeIdentity);
    assertEmptyNativeState(boundary.codexHome, recipe);
    const config = Buffer.from(renderCodexNativeBrokerConfig(recipe));
    const observations = [
      await observeFile(boundary.codexHome, `${boundary.codexHome}/config.toml`, {
        size: config.length, sha256: createHash("sha256").update(config).digest("hex"),
      }),
      await observeFile(boundary.codexHome, `${boundary.codexHome}/models.json`, {
        size: CODEX_NATIVE_CATALOG_BYTES, sha256: CODEX_NATIVE_CATALOG_SHA256,
      }),
    ];
    validateCodexDirectoryIdentity("codexHome", boundary.codexHomeIdentity);
    const files: CodexNativeBrokerFiles = Object.freeze({ kind: "codex-native-broker-prepared-files/v1" });
    prepared.set(files, { recipe, observations });
    validateCodexNativeBrokerFiles(files, recipe);
    return files;
  } catch {throw rejected();}
};

/** Called at explicit launch validation, never in a provider constructor. */
export const validateCodexNativeBrokerFiles = (files: CodexNativeBrokerFiles, recipe: CodexNativeBrokerRecipe): void => {
  const native = nativeFiles.get(files);
  if (native !== undefined) {
    if (native.recipe !== recipe) {throw rejected();}
    assertDarwinNativeCodexMaterialCurrent(native.material);
    const boundary = codexNativeBrokerBoundary(recipe);
    if (codexDarwinNativeLaunchObservation(boundary) !== inspectDarwinNativeCodexMaterial(native.material).observation) {throw rejected();}
    return;
  }
  const state = prepared.get(files);
  if (state === undefined || state.recipe !== recipe) {throw rejected();}
  try {
    const boundary = codexNativeBrokerBoundary(recipe);
    validateCodexDirectoryIdentity("codexHome", boundary.codexHomeIdentity);
    assertEmptyNativeState(boundary.codexHome, recipe);
    for (const file of state.observations) {
      if (!same(file.stats, lstatSync(file.path, { bigint: true }))) {throw rejected();}
    }
  } catch {throw rejected();}
};


interface NativePreparedFiles {
  readonly recipe: CodexNativeBrokerRecipe;
  readonly material: DarwinNativeCodexMaterial;
}
const nativeFiles = new WeakMap<CodexNativeBrokerFiles, NativePreparedFiles>();
const nativeRecipes = new WeakMap<CodexNativeBrokerRecipe, CodexNativeBrokerFiles>();
const attemptedSelections = new WeakSet<object>();
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Async fixed-three installation after the producer's actual committed claim.
 * No Host path access, auth file, generic write callback or cleanup receipt. */
export const installCodexDarwinNativeBrokerFiles = async (
  selection: DarwinNativeWorkspaceSelection | DarwinNativeExecutionLease, recipe: CodexNativeBrokerRecipe, catalogSource: Uint8Array,
): Promise<CodexNativeBrokerFiles> => {
  const boundary = codexNativeBrokerBoundary(recipe);
  const observation = codexDarwinNativeLaunchObservation(boundary);
  if (observation === undefined || attemptedSelections.has(selection) || nativeRecipes.has(recipe)) {throw rejected();}
  const original = inspectDarwinNativeLaunchObservation(observation);
  const catalog = Buffer.from(catalogSource);
  const config = Buffer.from(renderCodexNativeBrokerConfig(recipe));
  const installationId = randomUUID();
  if (catalog.length !== CODEX_NATIVE_CATALOG_BYTES || digest(catalog) !== CODEX_NATIVE_CATALOG_SHA256) {throw rejected();}
  attemptedSelections.add(selection);
  // The producer authenticates the opaque selection. Compare all retained roots
  // before asking for the one-use post-claim installation effect.
  const selected = "prepared" in inspectDarwinNativeExecutionLeaseSafe(selection)
    ? inspectDarwinNativeLaunchObservation(inspectDarwinNativeExecutionLease(selection as DarwinNativeExecutionLease).observation)
    : inspectDarwinNativeLaunchObservation(await readDarwinNativeLaunchObservation(selection as DarwinNativeWorkspaceSelection));
  if (selected.operationId !== original.operationId || selected.generation !== original.generation ||
      selected.leasedUid !== original.leasedUid ||
      (["privateRoot", "codexHome", "tmpDir", "workspace"] as const).some(key => {
        const a = selected[key]; const b = original[key];
        return a.path !== b.path || a.dev !== b.dev || a.ino !== b.ino || a.uid !== b.uid || a.mode !== b.mode;
      })) {throw rejected();}
  const material = "prepared" in inspectDarwinNativeExecutionLeaseSafe(selection)
    ? await installDarwinNativeCodexMaterial(selection as DarwinNativeExecutionLease, {config, catalog, installationId})
    : await installDarwinNativeCodexMaterial(selection as DarwinNativeWorkspaceSelection, {config, catalog, installationId});
  const actual = inspectDarwinNativeCodexMaterial(material);
  assertDarwinNativeCodexMaterialCurrent(material);
  if (actual.installationId !== installationId) {throw rejected();}
  const expected = [
    [actual.config, "config.toml", config, 0o600],
    [actual.catalog, "models.json", catalog, 0o600],
    [actual.installation, "installation_id", Buffer.from(installationId), 0o644],
  ] as const;
  validateInstalledMaterial(expected, boundary.codexHome, original);
  acceptCodexDarwinNativeMaterialObservation(boundary, material);
  const files: CodexNativeBrokerFiles = Object.freeze({kind: "codex-native-broker-prepared-files/v1"});
  nativeFiles.set(files, Object.freeze({recipe, material}));
  nativeRecipes.set(recipe, files);
  retainCodexDarwinNativeMaterialReader(recipe, () => codexDarwinNativeMaterialIdentity(recipe)!);
  validateCodexNativeBrokerFiles(files, recipe);
  return files;
};

const validateInstalledMaterial = (
  expected: readonly (readonly [ReturnType<typeof inspectDarwinNativeCodexMaterial>["config"], string, Uint8Array, number])[],
  codexHome: string,
  original: ReturnType<typeof inspectDarwinNativeLaunchObservation>,
): void => {
  for (const [fact, name, bytes, mode] of expected) {
    if (fact.path !== `${codexHome}/${name}` || fact.uid !== original.leasedUid ||
        fact.mode !== (0o100000 | mode) || fact.nlink !== 1 || fact.bytes !== bytes.length ||
        fact.sha256 !== digest(bytes) || fact.dev !== original.codexHome.dev || fact.ino <= 0n) {throw rejected();}
  }
  if (new Set(expected.map(([fact]) => `${fact.dev}:${fact.ino}`)).size !== 3) {throw rejected();}
};

const inspectDarwinNativeExecutionLeaseSafe = (value: DarwinNativeWorkspaceSelection | DarwinNativeExecutionLease): object => {
  try {return inspectDarwinNativeExecutionLease(value as DarwinNativeExecutionLease);} catch {return Object.freeze({});}
};

export const readCodexDarwinNativeMaterial = (recipe: CodexNativeBrokerRecipe): DarwinNativeCodexMaterial => {
  const files = nativeRecipes.get(recipe); const retained = files === undefined ? undefined : nativeFiles.get(files);
  if (retained === undefined) {throw rejected();}
  assertDarwinNativeCodexMaterialCurrent(retained.material);
  return retained.material;
};

/** Actual retained file observations, included in the synchronous final hash. */
export const codexDarwinNativeMaterialIdentity = (recipe: CodexNativeBrokerRecipe): readonly string[] | undefined => {
  const files = nativeRecipes.get(recipe);
  if (files === undefined) {return undefined;}
  validateCodexNativeBrokerFiles(files, recipe);
  const actual = inspectDarwinNativeCodexMaterial(nativeFiles.get(files)!.material);
  const roots = inspectDarwinNativeLaunchObservation(actual.observation);
  return Object.freeze([roots.operationId, roots.generation, String(roots.leasedUid), actual.installationId,
    ...[roots.privateRoot, roots.codexHome, roots.tmpDir, roots.workspace].flatMap(fact => [fact.path,
      String(fact.dev), String(fact.ino), String(fact.uid), String(fact.mode)]),
    ...[actual.config, actual.catalog, actual.installation].flatMap(fact => [fact.path, String(fact.dev),
      String(fact.ino), String(fact.uid), String(fact.mode), String(fact.nlink), String(fact.bytes), fact.sha256])]);
};
