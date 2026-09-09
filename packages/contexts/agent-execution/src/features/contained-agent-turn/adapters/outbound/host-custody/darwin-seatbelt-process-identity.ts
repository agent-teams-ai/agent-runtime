import { execFileSync } from "node:child_process";
import { recheckDarwinExecutable, type DarwinExecutablePin } from "./darwin-seatbelt-launch-projection.js";

export interface DarwinOwnedImage {
  readonly protocol: "ae-darwin-owned-image/v1"; readonly pid: number; readonly ppid: number; readonly pgid: number;
  readonly birthSeconds: string; readonly birthMicros: string; readonly dev: string; readonly ino: string;
}
export const captureDarwinOwnedImage = (value: unknown, pid: number, parent: number,
  target: DarwinExecutablePin): DarwinOwnedImage => {
  if (typeof value !== "object" || value === null) {throw new TypeError("Darwin owned image missing");}
  const data = value as DarwinOwnedImage;
  if (Object.keys(data).toSorted().join() !== "birthMicros,birthSeconds,dev,ino,pgid,pid,ppid,protocol" ||
      data.protocol !== "ae-darwin-owned-image/v1" || data.pid !== pid || data.ppid !== parent ||
      !Number.isSafeInteger(data.pgid) || data.pgid < 1 || data.dev !== target.dev || data.ino !== target.ino ||
      !/^[1-9][0-9]{0,19}$/u.test(data.birthSeconds) || !/^[0-9]{1,6}$/u.test(data.birthMicros) ||
      Number(data.birthMicros) > 999999) {throw new TypeError("Darwin owned image conflicts");}
  return Object.freeze({...data});
};
/** The caller supplies only the retained guardian child, never recovery PIDs. */
export const observeDarwinGuardian = (child: {readonly pid?: number | undefined; readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null}, observer: DarwinExecutablePin, node: DarwinExecutablePin): DarwinOwnedImage => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {throw new TypeError("Darwin guardian no longer owned");}
  recheckDarwinExecutable(observer); recheckDarwinExecutable(node);
  const bytes = execFileSync(observer.path, [String(child.pid), node.path],
    {encoding: "utf8", timeout: 250, maxBuffer: 2048, env: {PATH: "/usr/bin:/bin"}, stdio: ["ignore", "pipe", "ignore"]});
  return captureDarwinOwnedImage(JSON.parse(bytes), child.pid, process.pid, node);
};
