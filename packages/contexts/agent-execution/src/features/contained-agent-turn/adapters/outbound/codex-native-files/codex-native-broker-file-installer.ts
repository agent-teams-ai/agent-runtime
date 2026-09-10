import type { StableFilesystemHandle } from "@agent-teams/filesystem-custody/composition";
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {isAbsolute, relative, sep} from "node:path";
import {codexNativeBrokerBoundary, renderCodexNativeBrokerConfig,
  CODEX_NATIVE_CATALOG_BYTES, CODEX_NATIVE_CATALOG_SHA256, type CodexNativeBrokerRecipe}
  from "../codex-app-server/codex-app-server-launch-plan.js";
import {validateCodexDirectoryIdentity, type CodexAppServerPermissionBoundary}
  from "../codex-app-server/codex-app-server-permission-boundary.js";
import {descriptorChildPath, openBoundDirectory, openDirectoryEntry, fsyncDirectoryHandle,
  assertSameMountIdentity, type BoundContainedTurnRoot}
  from "../filesystem/contained-turn-filesystem-custody.js";

type RootBinding = Readonly<{
  canonicalBindSourcePath: string;
  identity: BoundContainedTurnRoot["identity"];
  uid: bigint;
  canonicalWorkspacePath: string;
}>;
interface InstallerOptions {
  readonly boundary: CodexAppServerPermissionBoundary;
  readonly catalogSource: Buffer;
  readonly ownerUid: number;
  readonly ownerGid: number;
  binding(): RootBinding;
  revalidate(): Promise<RootBinding>;
  deleted(): boolean;
}
const rejected = (): TypeError => new TypeError("Codex native file installation rejected");

/** Descriptor-relative writes only, with all residue left to the captured Host
 * root owner. No path from the rendered Docker projection is ever opened. */
export class NodeCodexNativeBrokerFileInstaller {
  readonly #handles = new Map<StableFilesystemHandle, Promise<void> | undefined>();
  #flight: Promise<void> | undefined;
  #closing = false;
  #installing = false;
  #installed = false;
  #fileDebt = false;
  public constructor(private readonly options: InstallerOptions) {}

  public snapshot(): Readonly<{installing: boolean; installed: boolean; debt: boolean; retainedHandles: number}> {
    return Object.freeze({installing: this.#installing, installed: this.#installed,
      debt: this.#handles.size > 0 || (this.#fileDebt && !this.options.deleted()), retainedHandles: this.#handles.size});
  }
  private active(): void {if (this.#closing) {throw rejected();}}
  private retain<Handle extends StableFilesystemHandle>(handle: Handle): Handle {this.#handles.set(handle, undefined); return handle;}
  private async close(handle: StableFilesystemHandle): Promise<void> {
    if (!this.#handles.has(handle)) {return;}
    // A failed close remains debt; never retry an ambiguously released FD.
    let flight = this.#handles.get(handle);
    if (flight === undefined) {
      flight = Promise.resolve().then(() => handle.close());
      this.#handles.set(handle, flight);
    }
    await flight;
    this.#handles.delete(handle);
  }
  private async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#handles.keys()].map(handle => this.close(handle)));
    if (results.some(result => result.status === "rejected")) {throw rejected();}
  }
  public async quiesce(): Promise<void> {
    this.#closing = true;
    await this.#flight?.catch(() => {});
    if (this.#handles.size !== 0) {throw rejected();}
  }
  public install(recipe: CodexNativeBrokerRecipe): Promise<void> {
    if (this.#flight !== undefined || this.#closing) {return Promise.reject(rejected());}
    this.#installing = true;
    this.#flight = Promise.resolve().then(() => this.run(recipe)).finally(async () => {
      try {await this.closeAll();} finally {this.#installing = false;}
    });
    return this.#flight;
  }
  private validateRecipe(recipe: CodexNativeBrokerRecipe): Buffer {
    this.active();
    if (codexNativeBrokerBoundary(recipe) !== this.options.boundary) {throw rejected();}
    const {ownerUid, ownerGid, catalogSource} = this.options;
    if (!Number.isSafeInteger(ownerUid) || !Number.isSafeInteger(ownerGid) ||
      ownerUid < 0 || ownerGid < 0 || process.getuid?.() !== ownerUid || process.getgid?.() !== ownerGid ||
      catalogSource.length !== CODEX_NATIVE_CATALOG_BYTES ||
      createHash("sha256").update(catalogSource).digest("hex") !== CODEX_NATIVE_CATALOG_SHA256) {throw rejected();}
    validateCodexDirectoryIdentity("codexHome", this.options.boundary.codexHomeIdentity);
    return Buffer.from(renderCodexNativeBrokerConfig(recipe));
  }
  private async home(): Promise<StableFilesystemHandle> {
    const binding = this.options.binding();
    const boundary = this.options.boundary;
    const path = relative(binding.canonicalBindSourcePath, boundary.codexHome);
    if (binding.uid !== BigInt(this.options.ownerUid) || binding.canonicalWorkspacePath !== boundary.workspaceRef ||
      path.length === 0 || isAbsolute(path) || path.split(sep).some(part => part === ".." || part === "")) {throw rejected();}
    if (await this.options.revalidate() !== binding) {throw rejected();}
    this.active();
    let handle = this.retain(await openBoundDirectory({absolutePath: binding.canonicalBindSourcePath,
      canonicalPath: binding.canonicalBindSourcePath, identity: binding.identity, private: true}));
    for (const component of path.split(sep)) {
      this.active();
      const next = this.retain(await openDirectoryEntry(handle, component));
      const stat = await next.stat({bigint: true});
      if (stat.uid !== BigInt(this.options.ownerUid) || (stat.mode & 0o7777n) !== 0o700n) {throw rejected();}
      await this.close(handle);
      handle = next;
    }
    const stat = await handle.stat({bigint: true});
    if (stat.dev !== BigInt(boundary.codexHomeIdentity.device) || stat.ino !== BigInt(boundary.codexHomeIdentity.inode)) {throw rejected();}
    return handle;
  }
  private async write(home: StableFilesystemHandle, name: "config.toml" | "models.json", bytes: Buffer): Promise<void> {
    this.active();
    // Mark the attempted creation before awaiting an acknowledgement. Partial
    // writes and ambiguous errors cannot be mistaken for a clean operation.
    this.#fileDebt = true;
    const handle = this.retain(await open(descriptorChildPath(home, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    await assertSameMountIdentity(home, handle);
    this.active();
    await handle.chown(this.options.ownerUid, this.options.ownerGid);
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat({bigint: true});
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(bytes.length) ||
      (stat.mode & 0o7777n) !== 0o600n || stat.uid !== BigInt(this.options.ownerUid) ||
      stat.gid !== BigInt(this.options.ownerGid)) {throw rejected();}
    await this.close(handle);
    await fsyncDirectoryHandle(home);
    this.active();
  }
  private async run(recipe: CodexNativeBrokerRecipe): Promise<void> {
    const config = this.validateRecipe(recipe);
    const home = await this.home();
    await this.write(home, "config.toml", config);
    await this.write(home, "models.json", this.options.catalogSource);
    validateCodexDirectoryIdentity("codexHome", this.options.boundary.codexHomeIdentity);
    await this.options.revalidate();
    await this.close(home);
    this.active();
    this.#installed = true;
  }
}
