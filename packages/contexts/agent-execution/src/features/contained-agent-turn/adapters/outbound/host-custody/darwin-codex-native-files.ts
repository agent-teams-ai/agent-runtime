import { constants, openSync, closeSync, lstatSync, fstatSync, fsyncSync, writeSync, unlinkSync, readdirSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { renderCodexNativeBrokerConfig, CODEX_NATIVE_CATALOG_SHA256, CODEX_NATIVE_CATALOG_BYTES,
  codexNativeBrokerBoundary, type CodexNativeBrokerRecipe } from "../codex-app-server/codex-native-broker-recipe.js";
import type { CodexAppServerPermissionBoundary } from "../codex-app-server/codex-app-server-permission-boundary.js";
import { darwinDigest } from "./darwin-route-durable-storage.js";
import type { DarwinRouteLifecycleJournal } from "./darwin-route-lifecycle-journal.js";

/** Fixed two-file installer under the accepted trusted-Host/name-bound model.
 * Erases only these retained entries; CODEX_HOME/root closure stays unproven. */
export class DarwinCodexNativeFiles {
  readonly #catalog: Buffer; readonly #home: BigIntStats;
  readonly #files = new Map<string, {fd: number; stats: BigIntStats; erased: boolean; closed: boolean}>();
  #attempted = false; #uncertain = false;
  public constructor(readonly boundary: CodexAppServerPermissionBoundary, catalog: Uint8Array,
    readonly journal: DarwinRouteLifecycleJournal, readonly active: () => void) {
    this.#catalog = Buffer.from(catalog); this.#home = lstatSync(boundary.codexHome, {bigint: true});
    if (this.#catalog.length !== CODEX_NATIVE_CATALOG_BYTES || darwinDigest(this.#catalog) !== CODEX_NATIVE_CATALOG_SHA256) {
      throw new TypeError("Darwin native catalog pin rejected");
    }
    this.assertHome();
    if (readdirSync(boundary.codexHome).length !== 0) {throw new TypeError("Darwin native home has residue");}
  }
  private assertHome(): void {
    const s = lstatSync(this.boundary.codexHome, {bigint: true});
    if (!s.isDirectory() || s.dev !== this.#home.dev || s.ino !== this.#home.ino || s.mode !== 0o40700n ||
        s.uid !== BigInt(process.getuid!()) || realpathSync(this.boundary.codexHome) !== this.boundary.codexHome) {
      throw new TypeError("Darwin native home changed");
    }
  }
  public install(recipe: CodexNativeBrokerRecipe): void {
    this.active(); this.assertHome();
    if (this.#attempted || codexNativeBrokerBoundary(recipe) !== this.boundary) {throw new TypeError("Darwin native recipe conflicts");}
    this.#attempted = true;
    for (const [name, bytes] of [["config.toml", Buffer.from(renderCodexNativeBrokerConfig(recipe))], ["models.json", this.#catalog]] as const) {
      this.active(); this.assertHome(); const path = `${this.boundary.codexHome}/${name}`;
      this.journal.record("native_file_create_intent", {path, sha256: darwinDigest(bytes)});
      try {
        const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const owned = {fd, stats: fstatSync(fd, {bigint: true}), erased: false, closed: false};
        this.#files.set(path, owned);
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count <= 0) {throw new Error("Darwin native file short write");} offset += count;
        }
        fsyncSync(fd); owned.stats = fstatSync(fd, {bigint: true});
        this.syncHome(); this.active(); this.assertHome();
        const named = lstatSync(path, {bigint: true});
        if (named.ino !== owned.stats.ino || named.dev !== owned.stats.dev || named.nlink !== 1n ||
            named.size !== BigInt(bytes.length) || named.mode !== 0o100600n) {throw new Error("Darwin native file changed");}
        this.journal.record("native_file_created", {path, dev: String(named.dev), ino: String(named.ino), sha256: darwinDigest(bytes)});
      } catch (error) {this.#uncertain = true; throw error;}
    }
  }
  private syncHome(): void {
    this.assertHome(); const fd = openSync(this.boundary.codexHome, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const held = fstatSync(fd, {bigint: true});
      if (held.dev !== this.#home.dev || held.ino !== this.#home.ino) {throw new Error("Darwin native directory conflicts");}
      fsyncSync(fd);
    } finally {closeSync(fd);}
  }
  public async cleanup(): Promise<boolean> {
    try {
      this.assertHome();
      for (const [path, file] of this.#files) {
        if (!file.erased) {
          const named = lstatSync(path, {bigint: true}); const held = fstatSync(file.fd, {bigint: true});
          if (!named.isFile() || named.nlink !== 1n || named.dev !== file.stats.dev || named.ino !== file.stats.ino ||
              held.dev !== named.dev || held.ino !== named.ino) {throw new Error("Darwin native cleanup identity changed");}
          this.journal.record("native_file_erase_intent", {path, dev: String(named.dev), ino: String(named.ino)});
          unlinkSync(path); file.erased = true; this.syncHome();
          if (fstatSync(file.fd, {bigint: true}).nlink !== 0n) {throw new Error("Darwin native erasure unproven");}
          this.journal.record("native_file_erased", {path});
        }
        if (!file.closed) {file.closed = true; closeSync(file.fd);}
      }
      return !this.#uncertain;
    } catch {this.#uncertain = true; return false;}
  }
}
