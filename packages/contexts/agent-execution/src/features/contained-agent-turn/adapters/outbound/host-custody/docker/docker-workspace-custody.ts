import type {DockerResidueIo, ResidueFile, ResidueIoScope, ResiduePin} from "./linux-docker-residue-io.js";
import {sameResidueInode} from "./linux-docker-residue-io.js";
import {residueFault} from "./linux-docker-residue-parsers.js";

export interface DockerMountedRootIdentity {readonly dev: bigint; readonly ino: bigint; readonly mountId: string;}
export interface DockerWorkspaceCapture {
  readonly namespace: Readonly<{dev: bigint; ino: bigint}>;
  readonly workspace: DockerMountedRootIdentity;
  readonly privateRoot: DockerMountedRootIdentity;
  readonly mountTable: string;
}
interface Mount {id: string; device: string; root: string; path: string; options: readonly string[];}
const INIT_SOURCE = "/usr/libexec/docker/docker-init";
const INIT_PATH = "/usr/sbin/docker-init";
const SYSTEM_MOUNTS = new Set(["/", "/workspace", "/agent-private", "/tmp", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue",
  "/proc", "/sys", "/sys/fs/cgroup", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf",
  "/proc/acpi", "/proc/asound", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger",
  "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug",
  "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"]);
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent === "/" ? "" : parent}/`);
const isSelectedInitMount = (parts: readonly string[], separator: number): boolean => {
  const init = parts[3] === INIT_SOURCE && parts[4] === INIT_PATH;
  if (!init && (parts[3] === INIT_SOURCE || parts[4] === INIT_PATH)) {throw residueFault();}
  const optional = parts.slice(6, separator);
  const options = parts[5]?.split(",") ?? [];
  if (init && (!options.includes("ro") || options.includes("rw") ||
    new Set(options).size !== options.length ||
    !(optional.length === 0 || optional.length === 1 && /^master:[1-9]\d*$/u.test(optional[0]!)))) {throw residueFault();}
  return init;
};
const parseMounts = (text: string): Mount[] => {
  const lines = text.trimEnd().split("\n");
  if (lines.length > 128) {throw residueFault();}
  const mounts: Mount[] = [];
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const line of lines) {
    const parts = line.split(" "); const separator = parts.indexOf("-");
    const init = isSelectedInitMount(parts, separator);
    const optional = parts.slice(6, separator);
    if (separator < 6 || parts.length !== separator + 4 || !/^\d+$/u.test(parts[0]!) ||
      !/^\d+:\d+$/u.test(parts[2]!) || !parts[3]!.startsWith("/") || line.includes("\\") ||
      (!init && !SYSTEM_MOUNTS.has(parts[4]!)) || paths.has(parts[4]!) || ids.has(parts[0]!) ||
      (!init && optional.some(field => /^(?:shared|master|propagate_from):/u.test(field)))) {throw residueFault();}
    paths.add(parts[4]!); ids.add(parts[0]!);
    mounts.push({id: parts[0]!, device: parts[2]!, root: parts[3]!, path: parts[4]!, options: parts[5]!.split(",")});
  }
  return mounts;
};

/** Bounded kernel grammar. Escaped/ambiguous names and all unselected mounts
 * fail closed. Mount IDs belong to the captured namespace, never the Host source. */
export const validateDockerWorkspaceMounts = (text: string, workspace: DockerMountedRootIdentity,
  privateRoot: DockerMountedRootIdentity, writable: boolean): void => {
  const mounts = parseMounts(text);
  for (const [path, identity, rw] of [["/workspace", workspace, writable], ["/agent-private", privateRoot, true]] as const) {
    const mount = mounts.find(entry => entry.path === path);
    if (mount === undefined || mount.id !== identity.mountId || !mount.options.includes(rw ? "rw" : "ro") ||
      mount.options.includes(rw ? "ro" : "rw")) {throw residueFault();}
    for (const other of mounts) {
      if (other === mount) {continue;}
      if (within(other.path, path) || other.device === mount.device &&
        (within(other.root, mount.root) || within(mount.root, other.root))) {throw residueFault();}
    }
  }
  if (!mounts.find(entry => entry.path === "/")?.options.includes("ro")) {throw residueFault();}
};

/** Docker daemon/Host trust only: the image init lock does not pin these bytes.
 * Walk from the pinned process root without following any path component. The
 * final bind crosses devices, so scope.child's same-filesystem rule cannot apply. */
const captureInit = async (scope: ResidueIoScope, root: ResidueFile, selected: Mount): Promise<ResiduePin> => {
  let parent = root;
  for (const name of ["usr", "sbin"]) {
    const pin = await scope.protect(await scope.acquire(() => scope.io.child(parent, name, true)), true);
    parent = pin.file;
  }
  const pin = await scope.protect(await scope.acquire(() => scope.io.child(parent, "docker-init", false)), false);
  if ((pin.facts.mode & 0o111) === 0 || await scope.io.mountId!(pin.file) !== selected.id) {throw residueFault();}
  return pin;
};

/** Only called inside the concrete residue owner's serialized process validation.
 * The caller retains all pins until containment; temporary failures stay debt. */
export const capturePinnedDockerWorkspace = async (scope: ResidueIoScope, process: ResiduePin,
  writable: boolean): Promise<DockerWorkspaceCapture> => {
  const io: DockerResidueIo = scope.io;
  if (io.procObject === undefined || io.mountId === undefined) {throw residueFault();}
  const magic = io.procObject.bind(io); const mountId = io.mountId.bind(io);
  await scope.verify(process);
  const namespace = await scope.acquire(() => magic(process.file, "ns/mnt"));
  const namespaceFacts = await io.stat(namespace);
  const root = await scope.acquire(() => magic(process.file, "root"));
  const rootFacts = await io.stat(root);
  const rootMountId = await mountId(root);
  if (!rootFacts.directory || rootFacts.nlink === 0n) {throw residueFault();}
  const mountFile = await scope.child(process, "mountinfo", false, process.facts.uid);
  const before = await scope.text(mountFile, 65536);
  const capture = async (name: string): Promise<DockerMountedRootIdentity> => {
    const file = await scope.acquire(() => io.child(root, name, true));
    const facts = await io.stat(file);
    if (!facts.directory || facts.nlink === 0n) {throw residueFault();}
    return Object.freeze({dev: facts.dev, ino: facts.ino, mountId: await mountId(file)});
  };
  const workspace = await capture("workspace"); const privateRoot = await capture("agent-private");
  validateDockerWorkspaceMounts(before, workspace, privateRoot, writable);
  const selectedInit = parseMounts(before).find(entry => entry.path === INIT_PATH);
  const init = selectedInit === undefined ? undefined : await captureInit(scope, root, selectedInit);
  const afterNamespace: ResidueFile = await scope.acquire(() => magic(process.file, "ns/mnt"));
  const afterFacts = await io.stat(afterNamespace);
  const afterRoot = await scope.acquire(() => magic(process.file, "root"));
  const afterRootFacts = await io.stat(afterRoot);
  if (rootFacts.dev !== afterRootFacts.dev || rootFacts.ino !== afterRootFacts.ino ||
    rootMountId !== await mountId(afterRoot) ||
    !before.split("\n").some(line => line.split(" ")[0] === rootMountId && line.split(" ")[4] === "/")) {throw residueFault();}
  if (await scope.text(mountFile, 65536) !== before || namespaceFacts.dev !== afterFacts.dev ||
    namespaceFacts.ino !== afterFacts.ino) {throw residueFault();}
  if (init !== undefined && selectedInit !== undefined) {
    const reopened = await captureInit(scope, afterRoot, selectedInit);
    await scope.verify(init);
    if (!sameResidueInode(init.facts, reopened.facts) || init.facts.nlink !== reopened.facts.nlink ||
      await mountId(init.file) !== selectedInit.id) {throw residueFault();}
  }
  await scope.verify(process); scope.check();
  return Object.freeze({namespace: Object.freeze({dev: namespaceFacts.dev, ino: namespaceFacts.ino}),
    workspace, privateRoot, mountTable: before});
};
