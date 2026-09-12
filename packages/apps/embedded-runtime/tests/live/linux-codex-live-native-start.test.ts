import assert from "node:assert/strict";
import {test} from "node:test";
import {createLiveNativeStartCollector, projectLiveNativeStart} from "./linux-codex-live-native-start.ts";

type Node = Parameters<ReturnType<typeof createLiveNativeStartCollector>["wrap"]>[0];
type Input = Parameters<Node["recipe"]>[0];
const diagnostic = {phase: "install", lastCompleted: "ingress-open", failingPhase: "install",
  cutoff: true, errorCode: "native-start-rejected"};

test("actual wrapper forwards once, preserves receiver/input/result and collects on rejection before return", async () => {
  const collector = createLiveNativeStartCollector();
  let calls = 0, reads = 0;
  const input = {kernel: {custodyId: "custody:one"}} as Input;
  const owner = {snapshot() {assert.equal(this, owner); reads++; return {nativeStart: diagnostic};}};
  const result = {nativeFiles: owner} as ReturnType<Node["recipe"]>;
  const node: Node = {recipe(actual) {assert.equal(this, node); assert.equal(actual, input); calls++; return result;}};
  const wrapped = collector.wrap(node);
  const failure = Object.freeze({get message() {throw new Error("must not read");}});
  await assert.rejects(collector.settle(async () => {
    assert.equal(wrapped(input), result);
    assert.equal(reads, 0);
    throw failure;
  }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(reads, 1);
  assert.deepEqual(collector.collect(), [{custodyId: "custody:one", nativeStart: diagnostic}]);
  collector.release();
  const releasedReads = reads;
  assert.deepEqual(collector.collect(), [{custodyId: "custody:one", nativeStart: diagnostic}]);
  collector.release();
  assert.equal(reads, releasedReads);
});

test("projection excludes hostile extras, accessors, proxies and invalid labels", () => {
  const hostile = {get credentials() {throw new Error("must not read");}, toJSON() {throw new Error("must not serialize");}};
  const value = projectLiveNativeStart(Object.defineProperties({nativeStart: diagnostic}, Object.getOwnPropertyDescriptors(hostile)));
  assert.deepEqual(value, diagnostic);
  const extra = Object.defineProperties({...diagnostic}, Object.getOwnPropertyDescriptors(hostile));
  assert.equal(JSON.stringify(projectLiveNativeStart({nativeStart: extra})), JSON.stringify(diagnostic));
  assert.equal(projectLiveNativeStart({nativeStart: {...diagnostic, phase: "secret"}}), undefined);
  assert.equal(projectLiveNativeStart({get nativeStart() {throw new Error("must not read");}}), undefined);
  assert.equal(projectLiveNativeStart({nativeStart: new Proxy({}, {getOwnPropertyDescriptor() {throw new Error("must not read");}})}), undefined);
});

test("success, absent diagnostics, throwing snapshot and recipe failure preserve outcomes and identities", async () => {
  const collector = createLiveNativeStartCollector();
  const wrapped = collector.wrap({recipe(input) {
    if (input.kernel.custodyId === "throw") {throw new Error("synthetic recipe failure");}
    return {nativeFiles: {snapshot() {
      if (input.kernel.custodyId === "bad") {throw new Error("private cause");}
      return {};
    }}} as ReturnType<Node["recipe"]>;
  }});
  const outcome = {};
  assert.equal(await collector.settle(async () => {
    for (const custodyId of ["absent", "bad"]) {wrapped({kernel: {custodyId}} as Input);}
    return outcome;
  }), outcome);
  assert.throws(() => wrapped({kernel: {custodyId: "throw"}} as Input), /synthetic recipe failure/u);
  assert.deepEqual(collector.collect(), ["absent", "bad"].map(custodyId => ({custodyId, nativeStart: undefined})));
});

test("retention is bounded and release leaves only immutable projected evidence", async () => {
  const collector = createLiveNativeStartCollector();
  let calls = 0, reads = 0;
  const snapshot = {nativeStart: {...diagnostic}};
  const result = {nativeFiles: {snapshot() {reads++; return snapshot;}}} as ReturnType<Node["recipe"]>;
  const wrapped = collector.wrap({recipe() {calls++; return result;}});
  await collector.settle(async () => {
    for (let i = 0; i < 65; i++) {assert.equal(wrapped({kernel: {custodyId: String(i)}} as Input), result);}
  });
  assert.equal(calls, 65);
  assert.equal(collector.collect().length, 64);
  collector.release();
  const finalReads = reads;
  snapshot.nativeStart.phase = "recipe-create";
  assert.equal(collector.collect()[0]!.nativeStart!.phase, "install");
  assert.equal(Object.isFrozen(collector.collect()[0]!.nativeStart), true);
  assert.equal(reads, finalReads);
});

for (const phase of ["native-plan-recognition", "mount-path-projection", "process-input-projection",
  "process-input-tmpdir", "process-input-executable", "reservation-evidence-finalize",
  "plan-publication", "prepared-handoff", "plan-root-validation", "bridge-open",
  "preparation-construction", "host-attach"] as const) {
  test(`existing collector emits post-finalizer ${phase} and only allowlisted category`, async () => {
    const nativeStart = {phase, lastCompleted: "return", failingPhase: phase, cutoff: true, errorCode: "unknown"};
    const collector = createLiveNativeStartCollector();
    const recipe = collector.wrap({recipe() {return {nativeFiles: {snapshot() {return {nativeStart};}}};}} as never);
    recipe({kernel: {custodyId: "custody:post-finalizer"}} as never);
    const failure = new Error("synthetic-secret");
    await assert.rejects(collector.settle(async () => {throw failure;}), error => error === failure);
    assert.deepEqual(collector.collect(), [{custodyId: "custody:post-finalizer", nativeStart}]);
    assert.equal(projectLiveNativeStart({nativeStart: {...nativeStart, errorCode: "ESECRET"}}), undefined);
    for (const field of ["phase", "lastCompleted", "failingPhase"] as const) {
      const expected = {...diagnostic, [field]: phase};
      const projected = projectLiveNativeStart({nativeStart: {...expected, error: failure}});
      assert.deepEqual(projected, expected);
      assert.equal(Object.isFrozen(projected), true);
      assert.equal(JSON.stringify(projected), JSON.stringify(expected));
      for (const invalid of ["SECRET", `${phase}-unknown`, "", undefined, 42, {}, false]) {
        assert.equal(projectLiveNativeStart({nativeStart: {...expected, [field]: invalid}}), undefined);
      }
    }
    assert.equal(projectLiveNativeStart({nativeStart: {...nativeStart, cutoff: "true"}}), undefined);
    assert.equal(projectLiveNativeStart({nativeStart: {...nativeStart, errorCode: failure}}), undefined);
  });
}
