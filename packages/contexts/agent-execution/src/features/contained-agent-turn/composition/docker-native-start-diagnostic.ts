/** Private readback only. Never retains thrown values or invokes observers. */
export type NativeStartPhase = "preflight" | "recipe-create" | "ingress-open" | "install" |
  "after-install" | "files-prepare-validate" | "after-files" | "recipe-build" |
  "recipe-validate" | "bind-session" | "return-validate" | "return" |
  "native-plan-recognition" | "mount-path-projection" | "process-input-projection" |
  "process-input-tmpdir" | "process-input-executable" | "reservation-evidence-finalize" |
  "plan-publication" | "prepared-handoff" | "plan-root-validation" | "bridge-open";
export interface NativeStartDiagnostic {
  readonly lastCompleted: NativeStartPhase | null;
  readonly failingPhase: NativeStartPhase | null;
  readonly phase: NativeStartPhase;
  readonly cutoff: boolean;
  readonly errorCode: "native-start-rejected" | "unknown" | null;
}
const retained = new WeakMap<object, NativeStartDiagnostic>();
const identities = new WeakMap<object, object>();
const identity = (key: object) => identities.get(key) ?? key;
/** Alias only retained private custody objects; never grants execution authority. */
export const linkNativeStartDiagnostic = (key: object, files: object): void => {
  try {identities.set(key, identity(files));} catch { /* Diagnostics cannot affect admission. */ }
};
export const nativeStartDiagnostic = (files: object): NativeStartDiagnostic | undefined => {
  try {return retained.get(identity(files));} catch {return undefined;}
};
export const retainNativeStartDiagnostic = (files: object) => {
  let state: NativeStartDiagnostic = {lastCompleted: null, failingPhase: null,
    phase: "preflight", cutoff: false, errorCode: null};
  const update = (delta: Partial<NativeStartDiagnostic>) => {
    try {state = Object.freeze({...state, ...retained.get(files), ...delta}); retained.set(files, state);} catch { /* Readback is best effort. */ }
  };
  update({});
  return {
    begin(phase: NativeStartPhase) {
      try {if (retained.get(files)?.failingPhase === null) {update({phase});}} catch { /* Readback only. */ }
    },
    complete() {
      try {if (retained.get(files)?.failingPhase === null) {update({lastCompleted: retained.get(files)!.phase});}} catch { /* Readback only. */ }
    },
    fail() {
      try {if (retained.get(files)?.failingPhase === null) {update({failingPhase: retained.get(files)!.phase, errorCode: "native-start-rejected"});}} catch { /* Readback only. */ }
    },
    cutoff() {update({cutoff: true});},
  };
};

/** Post-finalizer phases continue the same files-owned readback. No thrown value is inspected. */
export const recordNativeStart = (key: object, event: "begin" | "complete" | "fail", phase?: NativeStartPhase): void => {
  try {
    const files = identity(key);
    const state = retained.get(files);
    if (state === undefined || state.failingPhase !== null) {return;}
    const delta = event === "begin" ? {phase: phase!} : event === "complete"
      ? {lastCompleted: state.phase} : {failingPhase: state.phase, errorCode: "unknown" as const};
    retained.set(files, Object.freeze({...state, ...delta}));
  } catch { /* Diagnostics cannot affect admission or replace the original throw. */ }
};
export const nativeStartStep = <T>(key: object, phase: NativeStartPhase, action: () => T, resume?: NativeStartPhase): T => {
  recordNativeStart(key, "begin", phase);
  try {
    const result = action();
    recordNativeStart(key, "begin", phase); recordNativeStart(key, "complete");
    if (resume !== undefined) {recordNativeStart(key, "begin", resume);}
    return result;
  }
  catch (error) {recordNativeStart(key, "fail"); throw error;}
};
