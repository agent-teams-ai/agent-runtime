import type {DockerContainerObservation} from "./engine/docker-engine-port.js";
import {CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC, ResidueIoScope, sameResidueInode,
  type ResiduePin} from "./linux-docker-residue-io.js";
import {bootGeneration, checkResidueMounts, processCgroup, processPrivilege, processStart,
  recursivePopulation, residueFault} from "./linux-docker-residue-parsers.js";

export interface ResidueTree {
  readonly ancestry: readonly ResiduePin[];
  readonly proc: ResiduePin;
  readonly root: ResiduePin;
  readonly events: ResiduePin;
  readonly boot: string;
  readonly mounts: string;
}
export interface ResidueProcess {
  readonly directory: ResiduePin;
  readonly stat: ResiduePin;
  readonly cgroup: ResiduePin;
  readonly status: ResiduePin;
  readonly pid: number;
  readonly start: string;
  readonly path: string;
}

const kernelRoot = async (scope: ResidueIoScope, parent: ResiduePin, name: string): Promise<ResiduePin> =>
  scope.protect(await scope.acquire(() => scope.io.child(parent.file, name, true)), true);

const textChild = async (scope: ResidueIoScope, parent: ResiduePin, name: string, bytes: number): Promise<string> => {
  const pin = await scope.child(parent, name, false);
  try {return await scope.text(pin, bytes);} finally {await scope.release(pin.file);}
};

export const openResidueTree = async (scope: ResidueIoScope, parentPath: string): Promise<ResidueTree> => {
  // Bootstrap the real proc mount before using its deliberate /proc/PID/fd
  // magic links as Node's descriptor-relative open facility. All user/kernel
  // pathname components opened through those FDs use O_NOFOLLOW.
  const proc = await scope.protect(await scope.acquire(() => scope.io.open("/proc")), true);
  if (proc.filesystem !== PROC_SUPER_MAGIC) {throw residueFault();}
  const root = await scope.protect(await scope.acquire(() => scope.io.open("/")), true);
  const procFromRoot = await kernelRoot(scope, root, "proc");
  if (!sameResidueInode(proc.facts, procFromRoot.facts)) {throw residueFault();}
  const ancestry = [root, procFromRoot];
  let cursor = proc;
  for (const part of ["sys", "kernel", "random"]) {cursor = await scope.child(cursor, part, true);}
  const boot = bootGeneration(await textChild(scope, cursor, "boot_id", 64));
  const self = await scope.child(proc, String(process.pid), true, process.getuid?.() ?? 0);
  const mountFile = await scope.child(self, "mountinfo", false, process.getuid?.() ?? 0);
  const mountText = await scope.text(mountFile, 1_048_576);
  const mounts = checkResidueMounts(mountText);
  cursor = root;
  for (const part of ["sys", "fs", "cgroup"]) {
    cursor = await kernelRoot(scope, cursor, part);
    ancestry.push(cursor);
    const expected = part === "cgroup" ? CGROUP2_SUPER_MAGIC : 0x62656572n;
    if (cursor.filesystem !== expected) {throw residueFault();}
    if (part === "cgroup") {
      // The hierarchy root has no cgroup.type/cgroup.events. Only its
      // common-ancestor migration authority is needed here.
      for (const name of ["cgroup.procs", "cgroup.subtree_control"]) {
        const control = await scope.child(cursor, name, false);
        await scope.release(control.file);
      }
    }
  }
  for (const part of parentPath.slice(1).split("/")) {
    cursor = await scope.child(cursor, part, true);
    ancestry.push(cursor);
    // Migration out of the policy subtree also requires write access to the
    // common ancestor's cgroup.procs. Protect that entire chain, not just leaf
    // permissions, so a writable sibling cannot provide an escape route.
    await protectedGroup(scope, cursor);
  }
  const events = await scope.child(cursor, "cgroup.events", false);
  return {ancestry, proc, root: cursor, events, boot, mounts};
};

export const compareResidueTrees = async (scope: ResidueIoScope, held: ResidueTree, current: ResidueTree): Promise<void> => {
  if (held.boot !== current.boot || held.mounts !== current.mounts || held.ancestry.length !== current.ancestry.length ||
      !sameResidueInode(held.events.facts, current.events.facts)) {throw residueFault();}
  for (const [index, pin] of held.ancestry.entries()) {
    await scope.verify(pin);
    if (!sameResidueInode(pin.facts, current.ancestry[index]!.facts)) {throw residueFault();}
  }
  await scope.verify(held.events);
};

const protectedGroup = async (scope: ResidueIoScope, group: ResiduePin): Promise<void> => {
  if (await textChild(scope, group, "cgroup.type", 32) !== "domain\n") {throw residueFault();}
  // Root-owned directory AND migration controls. A non-root, cap-free
  // container cannot create delegated cgroups or move tasks out of this tree.
  for (const name of ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]) {
    const pin = await scope.child(group, name, false);
    await scope.release(pin.file);
  }
};

export const scanResidueTree = async (
  scope: ResidueIoScope,
  tree: ResidueTree,
  expected: ReadonlyMap<string, ResiduePin | undefined>,
  newLeaf?: string,
): Promise<ResiduePin | undefined> => {
  let visited = 0;
  let found: ResiduePin | undefined;
  const walk = async (group: ResiduePin, depth: number): Promise<void> => {
    scope.check();
    visited += 1;
    if (visited > 64 || depth > 16) {throw residueFault();}
    await protectedGroup(scope, group);
    const names = await scope.io.directories(group.file);
    scope.check();
    if (names.length > 64) {throw residueFault();}
    for (const name of names) {
      const child = await scope.child(group, name, true);
      if (depth === 0) {
        const pinned = expected.get(name);
        if (!expected.has(name) || (pinned === undefined && name !== newLeaf) ||
            (pinned !== undefined && !sameResidueInode(pinned.facts, child.facts))) {throw residueFault();}
        if (name === newLeaf) {found = child;}
      }
      await walk(child, depth + 1);
      if (child !== found) {await scope.release(child.file);}
    }
    await scope.verify(group);
  };
  // A shared policy ancestor can cover multiple accepted containers. It never
  // hosts tasks directly or accepts foreign sibling groups. populated=0 here
  // proves the stronger closure of ALL accepted sibling trees, conservatively
  // delaying one operation while another sibling is still populated.
  if (await textChild(scope, tree.root, "cgroup.procs", 4096) !== "") {throw residueFault();}
  await walk(tree.root, 0);
  return found;
};

export const pinResidueProcess = async (
  scope: ResidueIoScope,
  tree: ResidueTree,
  observation: Extract<DockerContainerObservation, {existence: "present"}>,
  expectedPath: string,
): Promise<ResidueProcess> => {
  const pid = observation.state.hostPid;
  const [uid, gid] = observation.resources.user.split(":").map(Number);
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 2_147_483_647 || uid === undefined || gid === undefined ||
      !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) {throw residueFault();}
  const directory = await scope.child(tree.proc, String(pid), true, uid);
  const stat = await scope.child(directory, "stat", false, uid);
  const cgroup = await scope.child(directory, "cgroup", false, uid);
  const status = await scope.child(directory, "status", false, uid);
  const start = processStart(await scope.text(stat, 8192), pid);
  if (processCgroup(await scope.text(cgroup, 4096)) !== expectedPath) {throw residueFault();}
  processPrivilege(await scope.text(status, 16_384), uid, gid);
  const result = {directory, stat, cgroup, status, pid, start, path: expectedPath};
  await verifyResidueProcess(scope, result, observation);
  return result;
};

export const verifyResidueProcess = async (
  scope: ResidueIoScope,
  held: ResidueProcess,
  observation: Extract<DockerContainerObservation, {existence: "present"}>,
): Promise<void> => {
  if (held.pid !== observation.state.hostPid || !observation.state.running || observation.state.status !== "running" ||
      observation.state.paused || observation.state.restarting || observation.state.dead) {throw residueFault();}
  const [uid, gid] = observation.resources.user.split(":").map(Number);
  await scope.verify(held.directory);
  if (processStart(await scope.text(held.stat, 8192), held.pid) !== held.start ||
      processCgroup(await scope.text(held.cgroup, 4096)) !== held.path) {throw residueFault();}
  processPrivilege(await scope.text(held.status, 16_384), uid!, gid!);
};

export const requireLeafMembership = async (
  scope: ResidueIoScope, leaf: ResiduePin, pid: number,
): Promise<void> => {
  const pids = await textChild(scope, leaf, "cgroup.procs", 65_536);
  if (!/^(?:[1-9][0-9]{0,9}\n)+$/u.test(pids) || !pids.split("\n").includes(String(pid))) {throw residueFault();}
  if (recursivePopulation(await textChild(scope, leaf, "cgroup.events", 128)) !== "residue") {throw residueFault();}
};
