import {sameDockerAuthority} from "./docker-host-custody-lifecycle-guards.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { clearTimeout, setTimeout } from "node:timers";
import type { DockerContainerAuthority, DockerEnginePort } from "./engine/docker-engine-port.js";
import { parseStrictJson } from "./serialization/strict-json.js";
import { LINUX_EXCLUSIVE_ROUTE_TABLE, linuxExclusiveRouteSeccomp, type LinuxExclusiveRouteEndpoint } from "./linux-exclusive-route-policy.js";
import { installLinuxExclusiveRoute, type LinuxExclusiveRouteBinding,
  type LinuxExclusiveRouteOwner } from "./linux-exclusive-route-owner.js";

export interface LinuxRouteToolPin {
  readonly path: string;
  readonly sha256: string;
}

const rejected = (): Error => new Error("Linux Docker exclusive route enforcement unavailable");
/** Failed opening transfers only cleanup custody, never route/first-write authority. */
export class LinuxExclusiveRouteOpeningError extends Error {
  readonly releaseAfterContainerRemoval: () => Promise<"quarantined">;
  constructor(releaseAfterContainerRemoval: () => Promise<"quarantined">) {
    super("Linux Docker exclusive route enforcement unavailable");
    this.releaseAfterContainerRemoval = releaseAfterContainerRemoval;
  }
}

const namespaceReadbacks = new WeakMap<LinuxExclusiveRouteOwner, Readonly<{
  authority: DockerContainerAuthority; endpoint: LinuxExclusiveRouteEndpoint; identity: string; active(): boolean;
}>>();

/** Projects only descriptor facts retained by this production owner. */
export const readNodeLinuxRouteNamespace = (owner: LinuxExclusiveRouteOwner,
  authority: DockerContainerAuthority, endpoint: LinuxExclusiveRouteEndpoint): string => {
  const retained = namespaceReadbacks.get(owner);
  if (retained === undefined || !retained.active() || !sameDockerAuthority(authority, retained.authority) ||
      endpoint.address !== retained.endpoint.address || endpoint.port !== retained.endpoint.port) {throw rejected();}
  return retained.identity;
};

// Private production scheduling is mandatory. unref permits Host exit; neither
// this timer nor performance.now proves Host-loss containment. The kernel set
// independently expires while the Host is stopped; endpoint quarantine and
// whole-machine suspend behavior remain separate, unqualified requirements.
// The owner retains namespace custody independently until exact removal.
const scheduleCutoff = (delayMs: number, callback: () => void): (() => void) => {
  const timer = setTimeout(callback, Math.ceil(delayMs));
  try {timer.unref();} catch (error) {clearTimeout(timer); throw error;}
  return () => {clearTimeout(timer);};
};
const call = () => ({deadlineEpochMs: Date.now() + 5_000, signal: new AbortController().signal});
const assertPlatform = (): void => {
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid?.() !== 0) {throw rejected();}
};

const openPinnedTool = (pin: LinuxRouteToolPin): number => {
  if (!/^\/[A-Za-z0-9/_.-]+$/u.test(pin.path) || !/^[a-f0-9]{64}$/u.test(pin.sha256) ||
      realpathSync(pin.path) !== pin.path) {throw rejected();}
  const fd = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0 ||
        (before.mode & 0o111) === 0 || before.size < 1 || before.size > 16 * 1024 * 1024) {throw rejected();}
    const hash = createHash("sha256").update(readFileSync(fd)).digest("hex");
    const after = fstatSync(fd);
    if (hash !== pin.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) {throw rejected();}
    return fd;
  } catch (error) {closeSync(fd); throw error;}
};

/**
 * Linux-only platform adapter. Pins must come from trusted product deployment
 * composition, never process.env or a canary report. The existing Docker owner
 * supplies its inspection port. No command runner is injectable; this adapter
 * invokes only descriptor-bound tools in the descriptor-bound
 * container network namespace. Its consumer is the Docker/Linux post-claim
 * preparation, which owns fresh init-before-exec ordering, the broker listener
 * and independent campaign teardown. This lease is still not live-canary
 * authority on its own: the broker session's Provider Access and Runtime
 * Security ports remain bound by outer composition, and the 21-field route
 * binding below carries PA facts this adapter never derives.
 */
export const openNodeLinuxExclusiveRoute = async (input: Readonly<{
  authority: DockerContainerAuthority;
  binding: LinuxExclusiveRouteBinding;
  endpoint: LinuxExclusiveRouteEndpoint;
  engine: Pick<DockerEnginePort, "inspect">;
  /** Remaining authoritative operation lease at entry, including preparation.
   * At least 4000 ms must remain after namespace/tool preparation. */
  lifetimeMs: number;
  nsenter: LinuxRouteToolPin;
  nft: LinuxRouteToolPin;
}>): Promise<LinuxExclusiveRouteOwner> => {
  const startedAtMs = performance.now();
  const lifetimeMs = input.lifetimeMs;
  assertPlatform();
  const seccomp = linuxExclusiveRouteSeccomp();
  const engine = input.engine;
  const authority = Object.freeze({...input.authority});
  const endpoint = Object.freeze({...input.endpoint});
  const observation = await engine.inspect(authority, call());
  if (observation.existence !== "present" || !observation.state.running || observation.state.hostPid < 1 ||
      observation.resources.seccompProfileSha256 !== seccomp.sha256 || observation.engine.cgroupVersion !== "2") {throw rejected();}
  const pid = observation.state.hostPid;
  const nsPath = `/proc/${pid}/ns/net`;
  const namespace = openSync(nsPath, constants.O_RDONLY);
  const opened = [namespace];
  let released = false;
  const release = (): void => {
    released = true;
    let failed = false;
    for (const fd of opened.splice(0).toReversed()) {try {closeSync(fd);} catch {failed = true;}}
    if (failed) {throw rejected();}
  };
  try {
    const identity = fstatSync(namespace, {bigint: true});
    const host = statSync("/proc/self/ns/net", {bigint: true});
    if (identity.dev === host.dev && identity.ino === host.ino) {throw rejected();}
    const nsenter = openPinnedTool(input.nsenter); opened.push(nsenter);
    const nft = openPinnedTool(input.nft); opened.push(nft);
    const current = await engine.inspect(authority, call());
    const pathIdentity = statSync(nsPath, {bigint: true});
    if (current.existence !== "present" || !current.state.running || current.state.hostPid !== pid ||
        current.state.startedAt !== observation.state.startedAt ||
        pathIdentity.dev !== identity.dev || pathIdentity.ino !== identity.ino) {throw rejected();}
    const invoke = (args: readonly string[]): Uint8Array => {
      try {
        return execFileSync("/proc/self/fd/3", ["--net=/proc/self/fd/5", "--", "/proc/self/fd/4", ...args], {
          env: {PATH: "/usr/sbin:/usr/bin", LANG: "C", LC_ALL: "C"},
          maxBuffer: 65_536, timeout: 1_000,
          stdio: ["pipe", "pipe", "pipe", nsenter, nft, namespace],
        });
      } catch {throw rejected();}
    };
    const owner = installLinuxExclusiveRoute({...input, endpoint, lifetimeMs, startedAtMs, monotonicNow: () => performance.now(), scheduleCutoff, kernel: {
      // nft's file reader rejects Node's socket-backed stdin. Its command buffer
      // accepts the same bounded JSON directly, without a shell or temporary file.
      transact: transaction => {invoke(["-j", transaction]);},
      readRules: () => parseStrictJson(invoke(["-j", "list", "table", "inet", LINUX_EXCLUSIVE_ROUTE_TABLE])),
      containerRemoved: async () => (await engine.inspect(authority, call())).existence === "absent",
      releaseNamespace: release,
    }});
    namespaceReadbacks.set(owner, Object.freeze({authority, endpoint,
      identity: `netns:${identity.dev}:${identity.ino}`, active: () => !released}));
    return owner;
  } catch {
    // A failed installation has attempted a deny-only cut. Retain descriptors
    // even on opening failure; the campaign must remove this exact container.
    // Failed observations may be retried, but success cannot erase quarantine.
    let flight: Promise<"quarantined"> | undefined;
    throw new LinuxExclusiveRouteOpeningError(() => {
      flight ??= (async () => {
        try {if ((await engine.inspect(authority, call())).existence === "absent") {release();}}
        catch { /* Unknown removal/close remains quarantined. */ }
        return "quarantined" as const;
      })();
      const current = flight;
      void current.then(result => {
        if (opened.length > 0 && flight === current) {flight = undefined;}
        return result;
      });
      return current;
    });
  }
};
