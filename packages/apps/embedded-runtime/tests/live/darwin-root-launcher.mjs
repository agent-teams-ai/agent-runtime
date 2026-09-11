#!/usr/bin/env node
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {constants, fstat} from "node:fs";
import {chmod, lstat, mkdtemp, open, readFile, realpath, rm} from "node:fs/promises";
import {createServer, createConnection} from "node:net";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {encodeDarwinNativeRootPacket, validateDarwinNativeRootPacketTemplate} from "./darwin-native-root-packet.mjs";

const executeFile = promisify(execFile);
const immutable = async path => /(^|,)\s*(uchg|schg)(,|$)/u.test((await executeFile("/usr/bin/stat", ["-f", "%Sf", path], {env: {PATH: "/usr/bin:/bin"}})).stdout.trim());
const fail = message => {throw new Error(`DARWIN_ROOT_LAUNCHER: ${message}`);};
const regular = async path => {
  const resolved = await realpath(path), stat = await lstat(path);
  if (resolved !== path || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) {fail("untrusted image");}
  return stat;
};
const directory = async path => {
  const resolved = await realpath(path), stat = await lstat(path);
  if (resolved !== path || !stat.isDirectory() || stat.isSymbolicLink()) {fail("untrusted directory");}
  return stat;
};
const descriptor = (stat, right) => ({dev: stat.dev, ino: stat.ino, right});
export const createDarwinPacketDescriptors = stats => {
  if (!Array.isArray(stats) || stats.length !== 5) {fail("FD5-7/9/10 identities required");}
  return stats.map((value, index) => descriptor(value, index < 3 ? 1 : index === 3 ? 2 : 3));
};

const validateNativeImageClosure = (activation, native) => {
  const fixedRoles = ["native-owner", "sandbox-exec", "codex", "node", "seatbelt-profile", "host-entrypoint", "host-peer-addon"];
  const imageRoles = native.packet.images.map((_, index) => fixedRoles[index] ?? `native-loader-${index}`);
  for (const [index, role] of imageRoles.entries()) {
    const image = native.packet?.images?.[index], entry = activation.files?.find(file => file.role === role);
    if (!image || !entry || image.path !== entry.path || image.sha256 !== entry.sha256) {fail("native fixed image closure refused");}
  }
};

/** Reads the adjacent immutable activation and constructs the exact packet bytes.
 * This function is inert: it never creates paths, opens provider routes or starts a process. */
export async function prepareDarwinRootLaunch(activationPath = join(import.meta.dirname, "activation.json"), expectedOwnerUid = 0, requireImmutable = true) {
  const path = await realpath(activationPath), stat = await regular(path);
  if (stat.uid !== expectedOwnerUid || (stat.mode & 0o777) !== 0o444) {fail("activation is not root-owned mode 0444");}
  const activation = JSON.parse(await readFile(path, "utf8"));
  if (activation.version !== 1 || activation.platform !== "darwin-arm64" || activation.candidate !== true || activation.qualified !== false) {
    fail("activation identity refused");
  }
  const native = activation.native;
  if (!native || await realpath(native.ownerPath) !== native.ownerPath) {fail("native owner identity refused");}
  const ownerStat = await regular(native.ownerPath);
  if (ownerStat.uid !== expectedOwnerUid || !(ownerStat.mode & 0o111) ||
      (requireImmutable && process.platform === "darwin" && !await immutable(native.ownerPath))) {fail("native owner custody refused");}
  validateNativeImageClosure(activation, native);
  await Promise.all([native.namespaceParent, native.leaseRegistry, native.journal].map(directory));
  const packetInput = {...native.packet};
  validateDarwinNativeRootPacketTemplate(packetInput);
  return Object.freeze({activation, activationPath: path, native, packetInput});
}

const socketPair = async root => new Promise((resolve, reject) => {
  const path = join(root, "route.sock"), server = createServer();
  server.once("error", reject);
  server.listen(path, () => {
    const client = createConnection(path); client.once("error", reject);
    server.once("connection", socket => {server.close(); resolve({client, socket});});
  });
});

const requireRootDarwin = () => {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.getgid?.() !== 0 || process.getegid?.() !== 0) {fail("root Darwin execution required");}
};

// Node exposes no public descriptor accessor for net.Socket. Read the retained
// native handle once, without duplicating or changing ownership of its descriptor.
export const statDarwinRouteSocket = async socket => {
  const fd = Reflect.get(socket, "_handle")?.fd;
  if (!Number.isInteger(fd) || fd < 0) {fail("route socket unavailable");}
  // bigint mode: a socket fd's st_dev is a sentinel (observed -1 on Darwin), which
  // a plain Number-mode fstat rounds to an unrepresentable value just past 2**64
  // (double precision loss). bigint mode returns the exact signed value instead.
  return promisify(fstat)(fd, {bigint: true});
};

export async function launchDarwinRoot(input) {
  requireRootDarwin();
  const prepared = await prepareDarwinRootLaunch(input?.activationPath);
  const scratch = await mkdtemp("/var/tmp/agent-runtime-darwin-launch-");
  const held = [];
  try {
    const manifestPath = join(scratch, "manifest.bin"), grantPath = join(scratch, "grant.bin");
    const manifestWriter = await open(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o400);
    const grantWriter = await open(grantPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o400);
    held.push(manifestWriter, grantWriter);
    const namespace = await open(prepared.native.namespaceParent, constants.O_RDONLY);
    const leases = await open(prepared.native.leaseRegistry, constants.O_RDONLY);
    const journal = await open(prepared.native.journal, constants.O_RDONLY);
    held.push(namespace, leases, journal);
    if (await realpath(prepared.native.providerInputPath) !== prepared.native.providerInputPath) {fail("provider input FIFO refused");}
    const fifoStat = await lstat(prepared.native.providerInputPath);
    if (!fifoStat.isFIFO() || fifoStat.uid !== 0 || (fifoStat.mode & 0o077)) {fail("provider input FIFO refused");}
    const fifo = await open(prepared.native.providerInputPath, constants.O_RDONLY | constants.O_NONBLOCK);
    held.push(fifo);
    const fifoWriter = await open(prepared.native.providerInputPath, constants.O_WRONLY | constants.O_NONBLOCK);
    try {await fifoWriter.write(Buffer.alloc(4));} finally {await fifoWriter.close();}
    const route = await socketPair(scratch); held.push(route.client, route.socket);
    const packetStats = await Promise.all([namespace.stat(), leases.stat(), journal.stat(), fifo.stat(),
      statDarwinRouteSocket(route.socket)]);
    const packet = encodeDarwinNativeRootPacket({...prepared.packetInput,
      fds: createDarwinPacketDescriptors(packetStats)});
    await manifestWriter.writeFile(packet.manifest); await manifestWriter.sync(); await chmod(manifestPath, 0o400);
    await grantWriter.writeFile(packet.grant); await grantWriter.sync(); await chmod(grantPath, 0o400);
    await manifestWriter.close(); await grantWriter.close();
    await executeFile("/usr/bin/chflags", ["uchg", manifestPath, grantPath], {env: {PATH: "/usr/bin:/bin"}});
    const manifest = await open(manifestPath, constants.O_RDONLY), grant = await open(grantPath, constants.O_RDONLY);
    held.push(manifest, grant);
    const child = spawn(prepared.native.ownerPath, [], {env: {PATH: "/usr/bin:/bin"},
      stdio: ["ignore", "inherit", "inherit", manifest.fd, grant.fd, namespace.fd, leases.fd, journal.fd,
        "ignore", fifo.fd, route.socket]});
    return await new Promise((resolve, reject) => {child.once("error", reject); child.once("exit", (code, signal) => resolve({code, signal}));});
  } finally {
    try {await executeFile("/usr/bin/chflags", ["nouchg", join(scratch, "manifest.bin"), join(scratch, "grant.bin")], {env: {PATH: "/usr/bin:/bin"}});} catch {}
    for (const owner of held.toReversed()) {
      if (typeof owner.close === "function") {try {await owner.close();} catch {}}
      else if (typeof owner.destroy === "function") {owner.destroy();}
    }
    await rm(scratch, {recursive: true, force: true});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {fail("zero arguments required");}
  const result = await launchDarwinRoot(); process.exitCode = result.code ?? 1;
}
