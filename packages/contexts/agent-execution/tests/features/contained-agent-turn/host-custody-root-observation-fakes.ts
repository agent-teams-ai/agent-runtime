import * as fs from "node:fs";
export * from "node:fs";

export const observationFault = {
  changedCtime: false,
  opened: new Set<number>(),
  closed: 0,
  reset() {this.changedCtime = false; this.opened.clear(); this.closed = 0;},
};
let replacedObservation: fs.BigIntStats | undefined;
export const openSync: typeof fs.openSync = (...args) => {
  if (observationFault.changedCtime) {
    const path = args[0];
    replacedObservation = fs.lstatSync(path, {bigint: true});
    fs.rmSync(path, {recursive: true});
    fs.mkdirSync(path, {mode: 0o700});
    fs.writeFileSync(`${path}/replacement-marker`, "actual replacement root");
  }
  const descriptor = fs.openSync(...args);
  observationFault.opened.add(descriptor);
  return descriptor;
};
export const closeSync: typeof fs.closeSync = descriptor => {
  fs.closeSync(descriptor);
  observationFault.opened.delete(descriptor);
  observationFault.closed++;
};
// Model a replacement whose filesystem recycled the original dev/ino. All
// captured identity fields remain identical; only the new birth's ctime differs.
export const fstatSync = (descriptor: number, options: {bigint: true}) => {
  const stats = fs.fstatSync(descriptor, options);
  if (!observationFault.changedCtime) {return stats;}
  if (replacedObservation === undefined) {throw new Error("replacement observation missing");}
  for (const field of ["dev", "ino", "mode", "uid"] as const) {
    Object.defineProperty(stats, field, {value: replacedObservation[field]});
  }
  return Object.defineProperty(stats, "ctimeNs", {value: replacedObservation.ctimeNs + 1n});
};
