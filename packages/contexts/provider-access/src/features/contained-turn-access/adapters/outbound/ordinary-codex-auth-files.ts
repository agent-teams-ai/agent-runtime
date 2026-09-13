import { constants } from 'node:fs';
import { open, lstat, realpath, mkdtemp, mkdir, symlink, writeFile, rm, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AUTH_DISABLED_FEATURES, ORDINARY_CODEX_AUTH_BINARY_SHA256, ORDINARY_CODEX_AUTH_MODEL, OrdinaryCodexAuthRefused } from './ordinary-codex-auth-contracts.js';

const refused = (): never => { throw new OrdinaryCodexAuthRefused(); };

type Identity = { dev: number; ino: number; uid: number; mode: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number };
// Directory child churn changes size/timestamps without replacing the owned directory.
// Regular auth/executable files must retain their contents, metadata and single link.
const same = (a: Identity, b: Identity, directory: boolean) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode &&
  (directory || (b.nlink === 1 && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
export async function stableAuthPath(path: string, directory: boolean, uid: number, privateMode: boolean): Promise<{ handle: FileHandle; identity: Identity; check(): Promise<void> }> {
  if (!isAbsolute(path) || await realpath(path) !== path) { return refused(); }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0));
  try {
    const stat = await handle.stat();
    if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) { refused(); }
    const check = async () => {
      if (!same(stat, await handle.stat(), directory) || !same(stat, await lstat(path), directory) || await realpath(path) !== path) {
        throw new OrdinaryCodexAuthRefused('identity_drift');
      }
    };
    await check(); return { handle, identity: stat, check };
  } catch (error) { await handle.close(); throw error; }
}

export async function prepareAuthFiles(input: { source: string; privateRoot: string; executable: string; check(): void }) {
  const uid = process.getuid?.();
  if (!uid || uid <= 0 || process.platform !== 'darwin' || process.arch !== 'arm64') { return refused(); }
  const owned: FileHandle[] = [];
  let home: string | undefined;
  try {
    const source = await stableAuthPath(input.source, true, uid, false); owned.push(source.handle);
    const auth = await stableAuthPath(join(input.source, 'auth.json'), false, uid, true); owned.push(auth.handle);
    if (auth.identity.size > 65_536) { refused(); }
    const root = await stableAuthPath(input.privateRoot, true, uid, true); owned.push(root.handle);
    if (input.privateRoot === input.source || input.privateRoot.startsWith(input.source + '/') || input.source.startsWith(input.privateRoot + '/')) { refused(); }
    const binary = await stableAuthPath(input.executable, false, uid, false); owned.push(binary.handle);
    if (binary.identity.size > 536_870_912 || !(binary.identity.mode & 0o111)) { refused(); }
    const hash = createHash('sha256');
    for await (const bytes of binary.handle.createReadStream({ autoClose: false })) { input.check(); hash.update(bytes); }
    if (hash.digest('hex') !== ORDINARY_CODEX_AUTH_BINARY_SHA256) { refused(); }
    await binary.check(); await source.check(); await auth.check(); input.check();
    home = await mkdtemp(join(input.privateRoot, 'ordinary-codex-auth-'));
    const homeIdentity = await lstat(home);
    if (homeIdentity.uid !== uid || (homeIdentity.mode & 0o077) || !homeIdentity.isDirectory()) { refused(); }
    await mkdir(join(home, 'tmp'), { mode: 0o700 });
    await symlink(join(input.source, 'auth.json'), join(home, 'auth.json'));
    const config = `cli_auth_credentials_store = "file"\nmodel = "${ORDINARY_CODEX_AUTH_MODEL}"\ndefault_permissions = "ordinary-auth"\nallow_login_shell = false\nproject_doc_max_bytes = 0\nweb_search = "disabled"\n[analytics]\nenabled = false\n[otel]\nexporter = "none"\ntrace_exporter = "none"\nmetrics_exporter = "none"\n[history]\npersistence = "none"\n[permissions.ordinary-auth]\nextends = ":read-only"\n[permissions.ordinary-auth.network]\nenabled = false\n`;
    await writeFile(join(home, 'config.toml'), config, { mode: 0o600, flag: 'wx' });
    const currentHome = home;
    const check = async () => {
      input.check(); await source.check(); await auth.check(); await binary.check();
      const now = await lstat(currentHome);
      if (now.dev !== homeIdentity.dev || now.ino !== homeIdentity.ino || now.uid !== uid || (now.mode & 0o077) || await realpath(currentHome) !== currentHome) { refused(); }
    };
    let cleaned = false;
    return {
      home: currentHome, sourceIdentity: `${source.identity.dev}:${source.identity.ino}:${auth.identity.dev}:${auth.identity.ino}`,
      check,
      async retain() {
        if (cleaned) { return; } cleaned = true;
        await Promise.all(owned.map(handle => handle.close()));
      },
      async cleanup() {
        if (cleaned) { return; } cleaned = true;
        try {
          await source.check(); await auth.check();
          const now = await lstat(currentHome);
          if (now.dev !== homeIdentity.dev || now.ino !== homeIdentity.ino || await realpath(currentHome) !== currentHome) { refused(); }
          await rm(currentHome, { recursive: true, force: false });
        } finally { await Promise.all(owned.map(handle => handle.close())); }
      },
    };
  } catch (error) {
    await Promise.all(owned.map(handle => handle.close()));
    // No material returns on partial setup; remove only the freshly created private path.
    if (home) { await rm(home, { recursive: true, force: true }); }
    throw error;
  }
}

export function authHelperArguments(source: string, executable: string): readonly string[] {
  // This is cooperative source write protection, not exclusive total-egress containment.
  const profile = `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(source)}))`;
  return ['-p', profile, executable, 'app-server', '--strict-config', '--listen', 'stdio://',
    ...AUTH_DISABLED_FEATURES.flatMap(feature => ['--disable', feature])];
}
