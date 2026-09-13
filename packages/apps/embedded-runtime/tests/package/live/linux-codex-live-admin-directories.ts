// Test-only filesystem administration. Importing this file performs no I/O.
import {createHash} from "node:crypto";
import {lstatSync, realpathSync, statSync} from "node:fs";
import {mkdir, mkdtemp, realpath, rm, stat} from "node:fs/promises";
import {isAbsolute, join, normalize, relative} from "node:path";
import type {LinuxCodexLivePins} from "./linux-codex-live-bootstrap.ts";

type ReadDirectories = LinuxCodexLivePins["node"]["readDirectories"];
type Directory = NonNullable<ReturnType<ReadDirectories>>["privateRoot"];
const below = (parent: string, child: string) => {
  const part = relative(parent, child);
  return part !== "" && part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};
const identity = (path: string): Directory => {
  if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
    throw new TypeError("Disposable directory was replaced");
  }
  const value = statSync(path, {bigint: true});
  if (!value.isDirectory()) {throw new TypeError("Disposable directory unavailable");}
  return Object.freeze({path, device: String(value.dev), inode: String(value.ino)});
};
const same = (left: Directory, right: Directory) =>
  left.path === right.path && left.device === right.device && left.inode === right.inode;

/** Caller supplies an exclusive test parent, never a project or authentication
 * home. This allocates both the empty source project and its disposable sibling.
 * AE subsequently creates and retains the actual operation workspace. Directory
 * readbacks here are filesystem facts, not opened-object or containment proof.
 */
export const allocateLinuxCodexLiveAdminDirectories = async (testParent: string) => {
  if (!isAbsolute(testParent) || normalize(testParent) !== testParent ||
      await realpath(testParent) !== testParent) {throw new TypeError("Canonical test parent required");}
  const parent = await stat(testParent);
  if (process.platform !== "linux" || !parent.isDirectory() ||
      parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new TypeError("Exclusive private test parent required");
  }
  const root = await mkdtemp(join(testParent, "linux-codex-live-"));
  const rootIdentity = identity(root);
  const source = join(root, "source");
  const disposable = join(root, "disposable");
  const paths = Object.freeze({workspace: join(disposable, "workspaces"),
    private: join(disposable, "private"), artifacts: join(disposable, "artifacts"),
    rehydration: join(disposable, "rehydration"), custody: join(disposable, "custody"),
    resource: join(disposable, "resource"), consumption: join(disposable, "consumption")});
  try {
    await mkdir(source, {mode: 0o700});
    await mkdir(disposable, {mode: 0o700});
    for (const path of Object.values(paths)) {await mkdir(path, {mode: 0o700});}
  } catch (error) {
    // No runtime owner has seen the tree during allocation.
    await rm(root, {recursive: true});
    throw error;
  }
  const pinned = Object.freeze(Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, identity(path)]))) as
    Readonly<Record<keyof typeof paths, Directory>>;
  let closed = false;
  let released = false;
  let launch: Readonly<{operationId: string; attemptId: string; custodyId: string;
    privateRoot: Directory; workspace: Directory; codexHome: string; tmpDir: string}> | undefined;
  let selected = false;
  let cleanupFlight: Promise<"released" | "pending"> | undefined;
  const check = () => {
    if (closed || !same(rootIdentity, identity(root)) ||
        Object.values(pinned).some(value => !same(value, identity(value.path)))) {
      throw new TypeError("Disposable tree admission closed");
    }
  };
  return Object.freeze({root,
    workspace: Object.freeze({canonicalProjectRoot: source, disposableRoot: disposable, root: paths.workspace}),
    artifacts: Object.freeze({canonicalProjectRoot: source, disposableRoot: disposable,
      root: paths.artifacts, workspaceRoot: paths.workspace, rehydrationRoot: paths.rehydration}),
    engineRoots: Object.freeze({workspaceSourceRoot: paths.workspace, privateRootSourceRoot: paths.private}),
    workspaceBackingTreeOwnership: Object.freeze({kind: "exclusive-host-owned-disposable-tree" as const,
      evidenceRef: `urn:linux-codex-live:allocated-tree:${createHash("sha256").update(JSON.stringify(rootIdentity)).digest("hex")}`}),
    async launchPaths(input: Parameters<LinuxCodexLivePins["launchPaths"]>[0], executablePath: string) {
      check();
      if (selected || !below(paths.workspace, input.workspaceAuthority.canonicalPath)) {
        throw new TypeError("Disposable launch already consumed or outside owned workspace");
      }
      selected = true;
      const privateRootPath = await mkdtemp(join(paths.private, "attempt-"));
      const codexHome = join(privateRootPath, "home");
      const tmpDir = join(privateRootPath, "tmp");
      await mkdir(codexHome, {mode: 0o700});
      await mkdir(tmpDir, {mode: 0o700});
      check();
      launch = Object.freeze({operationId: input.operationId, attemptId: input.attemptId,
        custodyId: input.custodyId, privateRoot: identity(privateRootPath),
        workspace: identity(input.workspaceAuthority.canonicalPath), codexHome, tmpDir});
      return Object.freeze({codexHome, tmpDir, privateRootPath, executablePath});
    },
    readDirectories(input: Parameters<ReadDirectories>[0]): ReturnType<ReadDirectories> {
      check();
      if (launch === undefined || launch.operationId !== input.kernel.operationId ||
          launch.attemptId !== input.kernel.attemptId || launch.custodyId !== input.kernel.custodyId ||
          input.record.privateRootPath !== launch.privateRoot.path ||
          input.record.boundary.workspaceRef !== launch.workspace.path ||
          !same(launch.privateRoot, identity(launch.privateRoot.path)) ||
          !same(launch.workspace, identity(launch.workspace.path))) {return;}
      return Object.freeze({custody: pinned.custody, resource: pinned.resource,
        consumption: pinned.consumption, privateRoot: launch.privateRoot, workspace: launch.workspace});
    },
    /** The administrative entrypoint must pass its retained real bootstrap
     * cleanup closure. A static release string is deliberately not an input.
     * Pending preserves the entire tree, including partly allocated attempts.
     */
    releaseAfterBootstrap(cleanup: () => Promise<"released" | "pending">): Promise<"released" | "pending"> {
      closed = true;
      if (released) {return Promise.resolve("released");}
      if (cleanupFlight !== undefined) {return cleanupFlight;}
      cleanupFlight = (async () => {
        try {
          if (await cleanup() !== "released" || !same(rootIdentity, identity(root))) {return "pending";}
          await rm(root, {recursive: true});
          released = true;
          return "released";
        } catch {return "pending";}
      })();
      void cleanupFlight.finally(() => {cleanupFlight = undefined;});
      return cleanupFlight;
    },
  });
};
