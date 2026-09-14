import {types} from "node:util";
import type {LinuxCodexDeploymentInfrastructure} from "../../../src/composition/linux-codex-deployment.ts";

type Recipe = LinuxCodexDeploymentInfrastructure["recipe"];
const phases = ["preflight", "recipe-create", "ingress-open", "install", "after-install",
  "files-prepare-validate", "after-files", "recipe-build", "recipe-validate", "bind-session",
  "return-validate", "return", "native-plan-recognition", "mount-path-projection",
  "process-input-projection", "process-input-tmpdir", "process-input-executable",
  "reservation-evidence-finalize", "plan-publication", "prepared-handoff", "plan-root-validation", "bridge-open",
  "preparation-construction", "host-attach"] as const;
// Read only named own data fields; never enumerate or invoke diagnostic accessors.
const field = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {return undefined;}
  return Object.getOwnPropertyDescriptor(value, key)?.value;
};
export const projectLiveNativeStart = (snapshot: unknown) => {
  const value = field(snapshot, "nativeStart");
  const phase = field(value, "phase"), lastCompleted = field(value, "lastCompleted");
  const failingPhase = field(value, "failingPhase"), cutoff = field(value, "cutoff");
  const errorCode = field(value, "errorCode");
  const validPhase = (v: unknown): v is typeof phases[number] =>
    typeof v === "string" && phases.some(p => p === v);
  if (!validPhase(phase) || !(lastCompleted === null || validPhase(lastCompleted)) ||
      !(failingPhase === null || validPhase(failingPhase)) || typeof cutoff !== "boolean" ||
      !(errorCode === null || errorCode === "native-start-rejected" || errorCode === "unknown")) {return;}
  return Object.freeze({phase, lastCompleted, failingPhase, cutoff, errorCode});
};

/** Disposable harness companion only; no production port or owner escapes. */
export const createLiveNativeStartCollector = () => {
  const owners = new Map<string, ReturnType<Recipe>["nativeFiles"]>();
  let records: readonly Readonly<{custodyId: string; nativeStart: ReturnType<typeof projectLiveNativeStart>}>[] = [];
  let released = false;
  const collect = () => {
    if (released) {return records;}
    records = Object.freeze([...owners].map(([custodyId, owner]) => {
      try {return Object.freeze({custodyId, nativeStart: projectLiveNativeStart(owner.snapshot())});}
      catch {return Object.freeze({custodyId, nativeStart: undefined});}
    }));
    return records;
  };
  return Object.freeze({
    wrap(node: Pick<LinuxCodexDeploymentInfrastructure, "recipe">): Recipe {
      const original = node.recipe;
      return input => {
        const result = original.call(node, input);
        if (!released && owners.size < 64) {owners.set(input.kernel.custodyId, result.nativeFiles);}
        return result;
      };
    },
    async settle<T>(attempt: () => Promise<T>): Promise<T> {
      try {return await attempt();} finally {collect();}
    },
    collect,
    release() {collect(); owners.clear(); released = true;},
  });
};
