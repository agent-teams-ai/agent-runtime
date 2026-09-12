import {linuxExclusiveRouteSeccomp} from "@agent-teams/agent-execution/composition";
import {rm} from "node:fs/promises";
import type {TestContext} from "node:test";
import {FakeDockerEngine} from "@agent-teams/agent-execution/composition";
import type {DockerContainerAuthority, DockerContainerObservation, DockerEngineCall, DockerEngineIdentity,
  DockerEnginePort} from "@agent-teams/agent-execution/composition";
import {composeLinuxDockerResidueCustody} from "@agent-teams/agent-execution/composition";
import {CGROUP2_SUPER_MAGIC, PROC_SUPER_MAGIC, type DockerResidueIo, type ResidueFile,
  type ResidueStat} from "@agent-teams/agent-execution/composition";
import {residueParent, residueLeaf} from "@agent-teams/agent-execution/composition";
import {createInput, digest, disposable, engineCall, MemoryStorage, owner, policy} from "./docker-host-custody-lifecycle-fixture.ts";

export const BOOT = "01234567-89ab-cdef-0123-456789abcdef";
export const ROOT_PATH = "/sys/fs/cgroup/agent.slice/agent-runtime.slice";
export const statText = (pid: number, ticks = "12345"): string => {
  const fields = ["S", ...Array<string>(51).fill("0")];
  fields[19] = ticks;
  return `${pid} (docker init (synthetic)) ${fields.join(" ")}\n`;
};
export const privilegeText = (): string => "Name:\tinit\nUid:\t65532\t65532\t65532\t65532\n" +
  "Gid:\t65532\t65532\t65532\t65532\nNoNewPrivs:\t1\n" +
  ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].map(name => `${name}:\t0000000000000000\n`).join("");

export interface KernelNode {
  readonly path: string;
  facts: ResidueStat;
  filesystem: bigint;
  contents: string;
  link: boolean;
}

/** Synthetic kernel facts only: no host process or host cgroup is touched. */
export class FixtureResidueIo implements DockerResidueIo {
  public readonly nodes = new Map<string, KernelNode>();
  public readonly handles = new Map<number, KernelNode>();
  public readonly events: string[] = [];
  public before: ((operation: string, node: KernelNode) => Promise<void>) | undefined;
  public peak = 0;
  private nextInode = 1n;
  private nextFd = 10;
  public readonly parent: string;
  public constructor(parent = ROOT_PATH) {
    this.parent = parent;
    this.directory("/");
    this.directory("/proc", PROC_SUPER_MAGIC);
    this.directory("/proc/sys");
    this.directory("/proc/sys/kernel");
    this.directory("/proc/sys/kernel/random");
    this.file("/proc/sys/kernel/random/boot_id", `${BOOT}\n`);
    this.directory(`/proc/${process.pid}`, PROC_SUPER_MAGIC, process.getuid?.() ?? 0);
    this.file(`/proc/${process.pid}/mountinfo`, "1 0 0:1 / /proc rw - proc proc rw\n" +
      "2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n", process.getuid?.() ?? 0);
    this.directory("/sys", 0x62656572n);
    this.directory("/sys/fs");
    this.directory("/sys/fs/cgroup", CGROUP2_SUPER_MAGIC);
    // Linux hierarchy-root ABI: cgroup.type and cgroup.events are non-root
    // interfaces. The policy subtree below it does expose them.
    this.file("/sys/fs/cgroup/cgroup.procs", "1\n");
    this.file("/sys/fs/cgroup/cgroup.subtree_control", "cpu memory pids\n");
    let current = "/sys/fs/cgroup";
    for (const name of parent.slice(current.length + 1).split("/")) {
      current += `/${name}`;
      this.group(current);
    }
  }
  public node(path: string): KernelNode {
    const node = this.nodes.get(path);
    if (node === undefined) {throw Object.assign(new Error("fixture missing"), {code: "ENOENT"});}
    return node;
  }
  public directory(path: string, filesystem?: bigint, uid = 0): KernelNode {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const fs = filesystem ?? this.nodes.get(parent)?.filesystem ?? 1n;
    const node: KernelNode = {path, filesystem: fs, contents: "", link: false,
      facts: {dev: fs, ino: this.nextInode++, nlink: 2n, uid, gid: 0, mode: 0o755, directory: true, file: false}};
    this.nodes.set(path, node);
    return node;
  }
  public file(path: string, contents: string, uid = 0): KernelNode {
    const node = this.directory(path, undefined, uid);
    node.facts = {...node.facts, mode: 0o644, directory: false, file: true, nlink: 1n};
    node.contents = contents;
    return node;
  }
  public group(path: string): void {
    this.directory(path, this.nodes.get(path)?.filesystem);
    this.file(`${path}/cgroup.type`, "domain\n");
    this.file(`${path}/cgroup.events`, "populated 0\nfrozen 0\n");
    this.file(`${path}/cgroup.procs`, "");
    this.file(`${path}/cgroup.threads`, "");
    this.file(`${path}/cgroup.subtree_control`, "");
  }
  public removeTree(path: string): void {
    for (const [name, node] of this.nodes) {
      if (name === path || name.startsWith(`${path}/`)) {
        node.facts = {...node.facts, nlink: 0n};
        this.nodes.delete(name);
      }
    }
  }
  private async opened(node: KernelNode): Promise<ResidueFile> {
    await this.before?.("open", node);
    if (node.link) {throw Object.assign(new Error("fixture symlink"), {code: "ELOOP"});}
    const file = {fd: this.nextFd++};
    this.handles.set(file.fd, node);
    this.peak = Math.max(this.peak, this.handles.size);
    this.events.push(`open:${node.path}`);
    return file;
  }
  public async open(path: "/" | "/proc"): Promise<ResidueFile> {return this.opened(this.node(path));}
  public async child(parent: ResidueFile, name: string, directory: boolean): Promise<ResidueFile> {
    if (name.includes("/") || name === ".." || name === ".") {throw new Error("unsafe child");}
    const base = this.handles.get(parent.fd)!.path;
    const node = this.node(`${base === "/" ? "" : base}/${name}`);
    if (directory !== node.facts.directory) {throw new Error("fixture type");}
    return this.opened(node);
  }
  public async stat(file: ResidueFile): Promise<ResidueStat> {return {...this.handles.get(file.fd)!.facts};}
  public async filesystem(file: ResidueFile): Promise<bigint> {return this.handles.get(file.fd)!.filesystem;}
  public async read(file: ResidueFile, maxBytes: number): Promise<string> {
    const node = this.handles.get(file.fd)!;
    await this.before?.("read", node);
    this.events.push(`read:${node.path}`);
    if (Buffer.byteLength(node.contents) > maxBytes) {throw new Error("fixture bounded read");}
    return node.contents;
  }
  public async directories(file: ResidueFile): Promise<readonly string[]> {
    const node = this.handles.get(file.fd)!;
    await this.before?.("directories", node);
    const result = [...this.nodes.values()].filter(child => child.path.startsWith(`${node.path}/`) &&
      !child.path.slice(node.path.length + 1).includes("/") && child.facts.directory);
    if (result.some(child => child.link)) {throw new Error("fixture symlink");}
    return result.map(child => child.path.slice(node.path.length + 1)).toSorted();
  }
  public async close(file: ResidueFile): Promise<void> {
    const node = this.handles.get(file.fd);
    if (node === undefined) {throw new Error("fixture double close");}
    await this.before?.("close", node);
    this.events.push(`close:${node.path}`);
    this.handles.delete(file.fd);
  }
}

export const residueFixture = async (t: TestContext, driver = "systemd", workspaceCapture?: Readonly<{bootId: string}>) => {
  const root = await disposable();
  const selectedPolicy = {...policy(root), cgroupParent: driver === "systemd" ? "agent-runtime.slice" : "agent-runtime/turns"};
  if (workspaceCapture !== undefined) {
    const seccomp = linuxExclusiveRouteSeccomp();
    selectedPolicy.seccompProfileJson = seccomp.json; selectedPolicy.seccompProfileSha256 = seccomp.sha256;
  }
  const parent = `/sys/fs/cgroup${residueParent(selectedPolicy.cgroupParent, driver)}`;
  const io = new FixtureResidueIo(parent);
  if (workspaceCapture !== undefined) {io.node("/proc/sys/kernel/random/boot_id").contents = `${workspaceCapture.bootId}\n`;}
  const fake = new FakeDockerEngine(selectedPolicy);
  const storage = new MemoryStorage();
  const controls = {deleteLeaf: false, descendants: false, driver, version: "2" as "1" | "2",
    afterStart: undefined as (() => void) | undefined, drift: {} as {-readonly [Key in keyof DockerEngineIdentity]?: DockerEngineIdentity[Key]}};
  const internalHost = digest("fake-host-boot:initial");
  const externalHost = digest(workspaceCapture?.bootId ?? BOOT);
  const inward = (authority: DockerContainerAuthority) => ({...authority, hostBootGenerationSha256: internalHost});
  const outward = (authority: DockerContainerAuthority) => ({...authority, hostBootGenerationSha256: externalHost});
  const engineIdentity = (identity: DockerEngineIdentity): DockerEngineIdentity => ({...identity,
    hostBootGenerationSha256: externalHost, cgroupDriver: controls.driver, cgroupVersion: controls.version, ...controls.drift});
  const observation = (value: DockerContainerObservation): DockerContainerObservation =>
    ({...value, authority: outward(value.authority), engine: engineIdentity(value.engine)});
  const leafPath = (authority: DockerContainerAuthority): string => `${parent}/${residueLeaf(authority.containerId, driver)}`;
  const engine: DockerEnginePort = {
    identity: async call => engineIdentity(await fake.identity(call)),
    create: async (input, call) => outward(await fake.create(input, call)),
    reconcileCreate: async (input, call) => outward(await fake.reconcileCreate(input, call)),
    attachCustody: (authority, call) => fake.attachCustody(inward(authority), call),
    inspect: async (authority, call) => observation(await fake.inspect(inward(authority), call)),
    start: async (authority, call) => {
      // The production decorator must already hold the stable ancestor here.
      if (![...io.handles.values()].some(node => node.path === `${parent}/cgroup.events`)) {throw new Error("root not pinned before start");}
      await fake.start(inward(authority), call);
      const actual = await fake.inspect(inward(authority), call);
      if (actual.existence !== "present") {throw new Error("fixture missing process");}
      const leaf = leafPath(authority);
      io.group(leaf);
      io.node(`${leaf}/cgroup.procs`).contents = `${actual.state.hostPid}\n`;
      io.node(`${leaf}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
      io.node(`${parent}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
      const proc = `/proc/${actual.state.hostPid}`;
      io.directory(proc, PROC_SUPER_MAGIC, 65532);
      io.file(`${proc}/stat`, statText(actual.state.hostPid), 65532);
      io.file(`${proc}/cgroup`, `0::${leaf.slice("/sys/fs/cgroup".length)}\n`, 65532);
      io.file(`${proc}/status`, privilegeText(), 65532);
      controls.afterStart?.();
    },
    stop: async (authority, call) => {
      await fake.stop(inward(authority), call);
      const leaf = leafPath(authority);
      io.node(`${leaf}/cgroup.procs`).contents = "";
      io.node(`${leaf}/cgroup.events`).contents = `populated ${controls.descendants ? 1 : 0}\nfrozen 0\n`;
      if (controls.deleteLeaf) {io.removeTree(leaf);}
      const populated = controls.descendants || [...io.nodes.values()].some(node =>
        node.path.startsWith(`${parent}/`) && node.path.endsWith("/cgroup.procs") && node.contents !== "");
      io.node(`${parent}/cgroup.events`).contents = `populated ${populated ? 1 : 0}\nfrozen 0\n`;
    },
    kill: (authority, call) => fake.kill(inward(authority), call),
    remove: async (authority, call) => {await fake.remove(inward(authority), call); io.removeTree(leafPath(authority));},
    wait: async (authority, call) => observation(await fake.wait(inward(authority), call)),
    logs: (authority, call) => fake.logs(inward(authority), call),
  };
  const composed = composeLinuxDockerResidueCustody({policy: selectedPolicy, journalStorage: storage}, engine, io);
  t.after(async () => {
    io.before = undefined;
    await composed.disposeResidue(engineCall());
    if (io.handles.size !== 0) {throw new Error(`fixture leaked ${io.handles.size} descriptors`);}
    await rm(root, {force: true, recursive: true});
  });
  const launch = (call = engineCall(), nonce?: string) => composed.lifecycle.launch({call,
    create: createInput(root, nonce), owner: nonce === undefined ? owner : {...owner, operationId: `operation:${nonce}`, attemptId: `attempt:${nonce}`}});
  const contain = (launched: Awaited<ReturnType<typeof launch>>, call: DockerEngineCall = engineCall()) =>
    composed.lifecycle.contain({authority: launched.authority, key: launched.key, call});
  return {root, parent, selectedPolicy, io, fake, engine, storage, controls, ...composed, launch, contain, leafPath};
};
