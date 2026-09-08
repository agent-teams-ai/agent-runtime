/** Private readback only. Never retains thrown values or invokes observers. */
export type NativeStartPhase = "preflight" | "recipe-create" | "ingress-open" | "install" |
  "after-install" | "files-prepare-validate" | "after-files" | "recipe-build" |
  "recipe-validate" | "bind-session" | "return-validate" | "return";
export interface NativeStartDiagnostic {
  readonly lastCompleted: NativeStartPhase | null;
  readonly failingPhase: NativeStartPhase | null;
  readonly phase: NativeStartPhase;
  readonly cutoff: boolean;
  readonly errorCode: "native-start-rejected" | null;
}
const retained = new WeakMap<object, NativeStartDiagnostic>();
export const nativeStartDiagnostic = (files: object): NativeStartDiagnostic | undefined => retained.get(files);
export const retainNativeStartDiagnostic = (files: object) => {
  let state: NativeStartDiagnostic = Object.freeze({lastCompleted: null, failingPhase: null,
    phase: "preflight", cutoff: false, errorCode: null});
  const update = (delta: Partial<NativeStartDiagnostic>) => {
    state = Object.freeze({...state, ...delta}); retained.set(files, state);
  };
  update({});
  return {
    begin(phase: NativeStartPhase) {update({phase});},
    complete() {update({lastCompleted: state.phase});},
    fail() {update({failingPhase: state.phase, errorCode: "native-start-rejected"});},
    cutoff() {update({cutoff: true});},
  };
};
