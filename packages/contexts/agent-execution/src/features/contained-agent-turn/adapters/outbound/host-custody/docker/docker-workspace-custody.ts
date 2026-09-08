import type {DockerResidueIo, ResidueFile, ResidueIoScope, ResiduePin} from "./linux-docker-residue-io.js";
import {residueFault} from "./linux-docker-residue-parsers.js";

export interface DockerMountedRootIdentity {readonly dev: bigint; readonly ino: bigint; readonly mountId: string;}
export interface DockerWorkspaceCapture {
  readonly namespace: Readonly<{dev: bigint; ino: bigint}>;
  readonly workspace: DockerMountedRootIdentity;
  readonly privateRoot: DockerMountedRootIdentity;
  readonly mountTable: string;
}
interface Mount {id: string; device: string; root: string; path: string; options: readonly string[];}
const SYSTEM_MOUNTS = new Set(["/", "/workspace", "/agent-private", "/tmp", "/dev", "/dev/pts", "/dev/shm", "/dev/mqueue",
  "/proc", "/sys", "/sys/fs/cgroup", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf",
  "/proc/acpi", "/proc/asound", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger",
  "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug",
  "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"]);
const within = (child: string, parent: string) => child === parent || child.startsWith(`${parent === "/" ? "" : parent}/`);
const parseMounts = (text: string): Mount[] => {
  const lines = text.trimEnd().split("\n");
  if (lines.length > 128) {throw residueFault();}
  const mounts: Mount[] = [];
  const paths = new Set<string>(); const ids = new Set<string>();
  for (const line of lines) {
    const parts = line.split(" "); const separator = parts.indexOf("-");
    if (separator < 6 || parts.length !== separator + 4 || !/^\d+$/u.test(parts[0]!) ||
      !/^\d+:\d+$/u.test(parts[2]!) || !parts[3]!.startsWith("/") || line.includes("\\") ||
      !SYSTEM_MOUNTS.has(parts[4]!) || paths.has(parts[4]!) || ids.has(parts[0]!) ||
      parts.slice(6, separator).some(field => /^(?:shared|master|propagate_from):/u.test(field))) {throw residueFault();}
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
  const afterNamespace: ResidueFile = await scope.acquire(() => magic(process.file, "ns/mnt"));
  const afterFacts = await io.stat(afterNamespace);
  const afterRoot = await scope.acquire(() => magic(process.file, "root"));
  const afterRootFacts = await io.stat(afterRoot);
  if (rootFacts.dev !== afterRootFacts.dev || rootFacts.ino !== afterRootFacts.ino ||
    rootMountId !== await mountId(afterRoot) ||
    !before.split("\n").some(line => line.split(" ")[0] === rootMountId && line.split(" ")[4] === "/")) {throw residueFault();}
  if (await scope.text(mountFile, 65536) !== before || namespaceFacts.dev !== afterFacts.dev ||
    namespaceFacts.ino !== afterFacts.ino) {throw residueFault();}
  await scope.verify(process); scope.check();
  return Object.freeze({namespace: Object.freeze({dev: namespaceFacts.dev, ino: namespaceFacts.ino}),
    workspace, privateRoot, mountTable: before});
};
