import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { DockerContainerAuthority, DockerEnginePort } from "./engine/docker-engine-port.js";
import { parseStrictJson } from "./serialization/strict-json.js";
import { linuxExclusiveRouteSeccomp, type LinuxExclusiveRouteEndpoint } from "./linux-exclusive-route-policy.js";
import { installLinuxExclusiveRoute, type LinuxExclusiveRouteBinding,
  type LinuxExclusiveRouteOwner } from "./linux-exclusive-route-owner.js";

export interface LinuxRouteToolPin {
  readonly path: string;
  readonly sha256: string;
}

const rejected = (): Error => new Error("Linux Docker exclusive route enforcement unavailable");
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
 * container network namespace. This adapter is intentionally not yet exported
 * as live-canary authority: composition must own fresh init-before-exec ordering,
 * the broker listener, PA/RS binding, and independent campaign teardown.
 */
export const openNodeLinuxExclusiveRoute = async (input: Readonly<{
  authority: DockerContainerAuthority;
  binding: LinuxExclusiveRouteBinding;
  endpoint: LinuxExclusiveRouteEndpoint;
  engine: Pick<DockerEnginePort, "inspect">;
  lifetimeMs: number;
  nsenter: LinuxRouteToolPin;
  nft: LinuxRouteToolPin;
}>): Promise<LinuxExclusiveRouteOwner> => {
  assertPlatform();
  const seccomp = linuxExclusiveRouteSeccomp();
  const engine = input.engine;
  const authority = Object.freeze({...input.authority});
  const observation = await engine.inspect(authority, call());
  if (observation.existence !== "present" || !observation.state.running || observation.state.hostPid < 1 ||
      observation.resources.seccompProfileSha256 !== seccomp.sha256 || observation.engine.cgroupVersion !== "2") {throw rejected();}
  const pid = observation.state.hostPid;
  const nsPath = `/proc/${pid}/ns/net`;
  const namespace = openSync(nsPath, constants.O_RDONLY);
  const opened = [namespace];
  const release = (): void => {
    let failed = false;
    for (const fd of opened.splice(0).toReversed()) {try {closeSync(fd);} catch {failed = true;}}
    if (failed) {throw rejected();}
  };
  try {
    const identity = fstatSync(namespace);
    const host = statSync("/proc/self/ns/net");
    if (identity.dev === host.dev && identity.ino === host.ino) {throw rejected();}
    const nsenter = openPinnedTool(input.nsenter); opened.push(nsenter);
    const nft = openPinnedTool(input.nft); opened.push(nft);
    const current = await engine.inspect(authority, call());
    const pathIdentity = statSync(nsPath);
    if (current.existence !== "present" || !current.state.running || current.state.hostPid !== pid ||
        current.state.startedAt !== observation.state.startedAt ||
        pathIdentity.dev !== identity.dev || pathIdentity.ino !== identity.ino) {throw rejected();}
    const invoke = (args: readonly string[], transaction?: string): Uint8Array => {
      try {
        return execFileSync("/proc/self/fd/3", ["--net=/proc/self/fd/5", "--", "/proc/self/fd/4", ...args], {
          env: {PATH: "/usr/sbin:/usr/bin", LANG: "C", LC_ALL: "C"},
          input: transaction, maxBuffer: 65_536, timeout: 1_000,
          stdio: ["pipe", "pipe", "pipe", nsenter, nft, namespace],
        });
      } catch {throw rejected();}
    };
    return installLinuxExclusiveRoute({...input, monotonicNow: () => performance.now(), kernel: {
      transact: transaction => {invoke(["-j", "-f", "-"], transaction);},
      readRules: () => parseStrictJson(invoke(["-j", "list", "table", "inet", "ar_provider_route_v1"])),
      containerRemoved: async () => (await engine.inspect(authority, call())).existence === "absent",
      releaseNamespace: release,
    }});
  } catch {
    // Closing our handles does not delete namespace policy while the container
    // exists. Campaign cleanup must still kill/remove that exact container.
    try {release();} catch { /* The caller must quarantine the failed opening. */ }
    throw rejected();
  }
};
