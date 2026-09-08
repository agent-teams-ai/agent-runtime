import {closeSync, constants, fstatSync, openSync, readSync} from "node:fs";

const reject = (): never => {throw new Error("Linux route Host privilege unavailable");};
// DAC_READ_SEARCH, NET_ADMIN, SYS_PTRACE, SYS_ADMIN. Positive-UID exec
// must carry these through both nsenter and nft, hence inheritable + ambient.
const required = (1n << 2n) | (1n << 12n) | (1n << 19n) | (1n << 21n);

const readStatusFields = (status: string): Map<string, string> => {
  const fields = new Map<string, string>();
  for (const line of status.trimEnd().split("\n")) {
    const match = /^([A-Za-z_][A-Za-z_0-9]*):[ \t]*(.*)$/u.exec(line);
    if (match === null) {return reject();}
    if (fields.has(match[1]!)) {reject();}
    fields.set(match[1]!, match[2]!);
  }
  return fields;
};

/** Private parser, never an admission port: production reads its own procfs. */
export const assertLinuxRoutePrivilegeStatus = (status: string, uid: number, gid: number): void => {
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0 || (uid > 0 && gid === 0) ||
      status.length > 16384) {reject();}
  const fields = readStatusFields(status);
  for (const [name, expected] of [["Uid", uid], ["Gid", gid]] as const) {
    const value = fields.get(name) ?? "";
    if (!/^\d+[ \t]+\d+[ \t]+\d+[ \t]+\d+$/u.test(value) ||
        value.split(/[ \t]+/u).some(id => Number(id) !== expected)) {reject();}
  }
  for (const name of ["CapEff", "CapPrm", "CapInh", "CapAmb"]) {
    const value = fields.get(name) ?? "";
    if (!/^[a-fA-F0-9]{16}$/u.test(value)) {reject();}
    if ((uid !== 0 || name === "CapEff" || name === "CapPrm") &&
        (BigInt(`0x${value}`) & required) !== required) {reject();}
  }
};

const readProc = (path: string, uid: number, gid: number): string => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || ![0, uid].includes(before.uid) || ![0, gid].includes(before.gid)) {reject();}
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) {break;}
      size += count;
    }
    const after = fstatSync(fd);
    if (size > 16384 || before.dev !== after.dev || before.ino !== after.ino ||
        before.uid !== after.uid || before.gid !== after.gid || before.mode !== after.mode ||
        before.ctimeMs !== after.ctimeMs) {reject();}
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, size));
  } finally {closeSync(fd);}
};

const sameProcessIdentity = (uid: number, gid: number): boolean =>
  process.getuid?.() === uid && process.geteuid?.() === uid &&
  process.getgid?.() === gid && process.getegid?.() === gid;

export const assertNodeLinuxRoutePrivilege = (): void => {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (process.platform !== "linux" || process.arch !== "x64" || uid === undefined || gid === undefined ||
      uid !== process.geteuid?.() || gid !== process.getegid?.()) {reject();}
  // Full identity maps reject capabilities scoped only to a remapped user namespace.
  for (const name of ["uid_map", "gid_map"]) {
    if (!/^\s*0\s+0\s+4294967295\s*$/u.test(readProc(`/proc/self/${name}`, uid!, gid!))) {reject();}
  }
  assertLinuxRoutePrivilegeStatus(readProc("/proc/self/status", uid!, gid!), uid!, gid!);
  if (!sameProcessIdentity(uid!, gid!)) {reject();}
};
