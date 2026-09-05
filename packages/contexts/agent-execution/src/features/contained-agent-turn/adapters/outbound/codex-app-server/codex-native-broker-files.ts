import { createHash } from "node:crypto";
import { lstatSync, readdirSync, type BigIntStats } from "node:fs";
import { capturePathLineage, openStablePath, pathLineagesEqual } from "@agent-teams/filesystem-custody";
import {
  CODEX_NATIVE_CATALOG_BYTES, CODEX_NATIVE_CATALOG_SHA256,
  codexNativeBrokerBoundary, renderCodexNativeBrokerConfig,
  type CodexNativeBrokerRecipe,
} from "./codex-native-broker-recipe.js";
import { validateCodexDirectoryIdentity } from "./codex-app-server-permission-boundary.js";

export interface CodexNativeBrokerFiles {
  readonly kind: "codex-native-broker-prepared-files/v1";
}
interface PreparedFiles {
  readonly recipe: CodexNativeBrokerRecipe;
  readonly observations: readonly Readonly<{ path: string; stats: BigIntStats }>[];
}
const prepared = new WeakMap<CodexNativeBrokerFiles, PreparedFiles>();
const rejected = (): TypeError => new TypeError("Codex native broker files rejected");
const assertEmptyNativeState = (home: string): void => {
  const entries = readdirSync(home).toSorted();
  if (entries.length !== 2 || entries[0] !== "config.toml" || entries[1] !== "models.json") {throw rejected();}
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
  try {
    validateCodexDirectoryIdentity("codexHome", boundary.codexHomeIdentity);
    assertEmptyNativeState(boundary.codexHome);
    const config = Buffer.from(renderCodexNativeBrokerConfig(recipe));
    const observations = [
      await observeFile(boundary.codexHome, `${boundary.codexHome}/config.toml`, {
        size: config.length, sha256: createHash("sha256").update(config).digest("hex"),
      }),
      await observeFile(boundary.codexHome, recipe.catalogPath, {
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
  const state = prepared.get(files);
  if (state === undefined || state.recipe !== recipe) {throw rejected();}
  try {
    const boundary = codexNativeBrokerBoundary(recipe);
    validateCodexDirectoryIdentity("codexHome", boundary.codexHomeIdentity);
    assertEmptyNativeState(boundary.codexHome);
    for (const file of state.observations) {
      if (!same(file.stats, lstatSync(file.path, { bigint: true }))) {throw rejected();}
    }
  } catch {throw rejected();}
};
