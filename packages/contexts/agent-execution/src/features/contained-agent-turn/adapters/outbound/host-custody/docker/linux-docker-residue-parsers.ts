import {createHash} from "node:crypto";
import type {DockerEngineIdentity} from "./engine/docker-engine-port.js";

export const residueFault = (): Error => new Error("Linux Docker residue custody is unproven");
export const residueHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const residueComponent = (value: string): boolean =>
  /^[A-Za-z0-9_.-]{1,255}$/u.test(value) && value !== "." && value !== "..";

export const residueParent = (parent: string, driver: string): string => {
  if (parent.length > 1024 || !parent.split("/").every(residueComponent) || parent.split("/").length > 16) {
    throw residueFault();
  }
  if (driver === "cgroupfs") {return `/${parent}`;}
  // Docker's systemd driver accepts a slice name, not a filesystem path.
  // a-b.slice expands to /a.slice/a-b.slice; paths/escapes/root slices are rejected.
  if (driver !== "systemd" || !/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*\.slice$/u.test(parent)) {
    throw residueFault();
  }
  const parts = parent.slice(0, -6).split("-");
  if (parts.length > 16) {throw residueFault();}
  return `/${parts.map((_, index) => `${parts.slice(0, index + 1).join("-")}.slice`).join("/")}`;
};

export const residueLeaf = (id: string, driver: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(id)) {throw residueFault();}
  return driver === "systemd" ? `docker-${id}.scope` : id;
};

export const processCgroup = (text: string): string => {
  const match = /^0::(\/[^\n]*)\n$/u.exec(text);
  const path = match?.[1];
  if (path === undefined || path.length > 4096 || !path.slice(1).split("/").every(residueComponent)) {
    throw residueFault();
  }
  return path;
};

export const processStart = (text: string, pid: number): string => {
  // comm can contain spaces, parentheses and newlines. The last ') ' bounds it.
  const end = text.lastIndexOf(") ");
  if (!text.startsWith(`${pid} (`) || end < 3 || !text.endsWith("\n")) {throw residueFault();}
  const fields = text.slice(end + 2, -1).split(" ");
  if (fields.length < 50 || fields.length > 64 || !/^[RSDZTWtXxKPI]$/u.test(fields[0] ?? "") ||
      !fields.slice(1).every(field => /^-?(?:0|[1-9][0-9]{0,19})$/u.test(field)) ||
      !/^[1-9][0-9]{0,19}$/u.test(fields[19] ?? "")) {throw residueFault();}
  if (BigInt(fields[19]!) > 0xffff_ffff_ffff_ffffn) {throw residueFault();}
  return fields[19]!;
};

export const processPrivilege = (text: string, uid: number, gid: number): void => {
  if (!text.endsWith("\n")) {throw residueFault();}
  const facts = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([A-Za-z0-9_]+):[\t ]+(.*)$/u.exec(line);
    if (match === null || facts.has(match[1]!)) {throw residueFault();}
    facts.set(match[1]!, match[2]!);
  }
  for (const [name, id] of [["Uid", uid], ["Gid", gid]] as const) {
    if (facts.get(name)?.split(/\s+/u).join(" ") !== Array<string>(4).fill(String(id)).join(" ")) {
      throw residueFault();
    }
  }
  if (facts.get("NoNewPrivs") !== "1" ||
      ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].some(name => facts.get(name) !== "0000000000000000")) {
    throw residueFault();
  }
};

/** cgroup.events populated is recursive, including live processes in descendants.
 * https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html
 * Unknown/duplicate/truncated kernel fields never become an empty observation. */
export const recursivePopulation = (text: string): "empty" | "residue" => {
  const match = /^populated ([01])\nfrozen ([01])\n$/u.exec(text);
  if (match === null) {throw residueFault();}
  return match[1] === "0" ? "empty" : "residue";
};

export const bootGeneration = (text: string): string => {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\n$/u.test(text)) {throw residueFault();}
  // Same digest preimage as the existing Docker endpoint owner.
  return residueHash(text.trim());
};

export const sameResidueEngine = (left: DockerEngineIdentity, right: DockerEngineIdentity): boolean =>
  (Object.keys(left) as (keyof DockerEngineIdentity)[]).every(key => left[key] === right[key]);

const mountPath = (value: string): string => {
  if (/\\(?!040|011|012|134)/u.test(value)) {throw residueFault();}
  const escapes: Readonly<Record<string, string>> = {"040": " ", "011": "\t", "012": "\n", "134": "\\"};
  return value.replace(/\\([0-9]{3}|.)/gu, (_match, code: string) => {
    if (escapes[code] === undefined) {throw residueFault();}
    return escapes[code];
  });
};
const overlaysResidueFacts = (path: string): boolean => {
  const boot = "/proc/sys/kernel/random/boot_id";
  return path.startsWith("/sys/fs/cgroup/") || /^\/proc\/(?:[0-9]+|self|thread-self)(?:\/|$)/u.test(path)
    || (path.startsWith("/proc/") && (path === boot || boot.startsWith(`${path}/`)));
};

/** Seal only mounts that establish our kernel view. Unrelated container mounts
 * and binfmt_misc cannot replace the proc/cgroup facts read through held FDs. */
export const checkResidueMounts = (text: string): string => {
  if (!text.endsWith("\n")) {throw residueFault();}
  let proc = 0;
  let cgroup = 0;
  const relevant: string[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length !== separator + 4 ||
        !/^[0-9]+$/u.test(fields[0]!) || !/^[0-9]+$/u.test(fields[1]!) ||
        !/^[0-9]+:[0-9]+$/u.test(fields[2]!)) {throw residueFault();}
    const mount = mountPath(fields[4]!);
    if (overlaysResidueFacts(mount)) {throw residueFault();}
    if (["/", "/proc", "/sys", "/sys/fs", "/sys/fs/cgroup"].includes(mount)) {relevant.push(line);}
    if (mount === "/proc") {
      if (fields[3] !== "/" || fields[separator + 1] !== "proc") {throw residueFault();}
      proc += 1;
    }
    if (mount === "/sys/fs/cgroup") {
      if (fields[3] !== "/" || fields[separator + 1] !== "cgroup2") {throw residueFault();}
      cgroup += 1;
    }
  }
  if (proc !== 1 || cgroup !== 1) {throw residueFault();}
  return residueHash(relevant.toSorted().join("\n"));
};
