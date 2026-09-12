import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";

import {
  bindCooperativeProcessGroupGuardian,
  createCooperativeProcessGroupAuthorityFactory,
  type PosixProcessGroupObservation,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-posix-process-group.js";

const guardianFor = (pid: number, signalGroup: () => Promise<"sent" | "unproven">) => ({
  child: { pid } as ChildProcessWithoutNullStreams,
  signalGroup,
});

test("cooperative empty observation retires signals and observations for a reused PGID", async context => {
  const kill = context.mock.method(process, "kill", () => true);
  let observation: "empty" | "residue" = "empty";
  const observedGroups: number[] = [];
  const authority = await createCooperativeProcessGroupAuthorityFactory({
    async observe(pgid) {observedGroups.push(pgid); return observation;},
  }).create("custody:retired-group");
  const signal = context.mock.fn(async () => "sent" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_001, signal));
  assert.equal(await authority.attachGuardian(42_001), true);
  assert.equal(await authority.killAll(), true);
  assert.equal(signal.mock.callCount(), 1);
  assert.deepEqual(signal.mock.calls[0]?.arguments, ["SIGKILL"]);
  assert.equal(await authority.proveEmpty(10, () => 0), "empty");

  // The same numeric PGID now denotes an unrelated group.
  observation = "residue";
  assert.equal(await authority.killAll(), true);
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(await authority.close(), true);
  assert.equal(await authority.close(), true);
  assert.equal(await authority.attachGuardian(42_001), false);
  assert.equal(await authority.attachGuardian(42_002), false);
  const replacementSignal = context.mock.fn(async () => "sent" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_001, replacementSignal));
  assert.equal(await authority.proveEmpty(0, () => 0), "empty");
  assert.equal(await authority.killAll(), true);
  assert.deepEqual(observedGroups, [42_001]);
  assert.equal(signal.mock.callCount(), 1);
  assert.equal(replacementSignal.mock.callCount(), 0);
  assert.equal(kill.mock.callCount(), 0);
});

test("cooperative signals require the attached guardian identity and cannot be rebound", async context => {
  const kill = context.mock.method(process, "kill", () => true);
  const authority = await createCooperativeProcessGroupAuthorityFactory().create("custody:bound-group");
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await authority.attachGuardian(invalid), false);
  }
  assert.equal(await authority.attachGuardian(42_001), true);
  assert.equal(await authority.attachGuardian(42_002), false);
  assert.equal(await authority.killAll(), false);
  const mismatched = context.mock.fn(async () => "sent" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_002, mismatched));
  assert.equal(await authority.killAll(), false);
  const replacement = context.mock.fn(async () => "sent" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_001, replacement));
  assert.equal(await authority.killAll(), false);
  assert.equal(mismatched.mock.callCount(), 0);
  assert.equal(replacement.mock.callCount(), 0);
  assert.equal(kill.mock.callCount(), 0);
});

test("cooperative ambiguity and deadlines preserve observation retries without numeric signals", async context => {
  const kill = context.mock.method(process, "kill", () => true);
  let observation: PosixProcessGroupObservation = "unproven";
  const observe = context.mock.fn(async () => observation);
  const authority = await createCooperativeProcessGroupAuthorityFactory({ observe }).create("custody:ambiguous");
  const signal = context.mock.fn(async () => "unproven" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_001, signal));
  assert.equal(await authority.attachGuardian(42_001), true);
  assert.equal(await authority.killAll(), false);
  assert.equal(await authority.proveEmpty(0, () => 0), "unproven");
  assert.equal(observe.mock.callCount(), 0);
  assert.equal(await authority.proveEmpty(10, () => 0), "unproven");
  assert.equal(await authority.close(), false);

  observation = "residue";
  let now = 0;
  assert.equal(await authority.proveEmpty(1, () => now++), "unproven");
  assert.equal(await authority.close(), false);
  assert.equal(await authority.killAll(), false);
  assert.equal(signal.mock.callCount(), 2);

  observation = "empty";
  assert.equal(await authority.proveEmpty(10, () => 0), "empty");
  assert.equal(await authority.close(), true);
  assert.equal(await authority.killAll(), true);
  assert.equal(signal.mock.callCount(), 2);
  assert.equal(kill.mock.callCount(), 0);
});

test("overlapping cooperative observations cannot revive a retired group", async context => {
  const kill = context.mock.method(process, "kill", () => true);
  const pending = Promise.withResolvers<PosixProcessGroupObservation>();
  let observations = 0;
  const authority = await createCooperativeProcessGroupAuthorityFactory({
    async observe() {
      observations += 1;
      return observations === 1 ? pending.promise : "empty";
    },
  }).create("custody:overlapping-observations");
  const signal = context.mock.fn(async () => "sent" as const);
  bindCooperativeProcessGroupGuardian(authority, guardianFor(42_001, signal));
  assert.equal(await authority.attachGuardian(42_001), true);
  const stale = authority.proveEmpty(10, () => 0);
  assert.equal(await authority.proveEmpty(10, () => 0), "empty");
  assert.equal(await authority.close(), true);
  pending.resolve("residue");
  assert.equal(await stale, "empty");
  assert.equal(await authority.killAll(), true);
  assert.equal(observations, 2);
  assert.equal(signal.mock.callCount(), 0);
  assert.equal(kill.mock.callCount(), 0);
});

test("closing an unattached cooperative authority prevents late guardian attachment", async context => {
  const kill = context.mock.method(process, "kill", () => true);
  const authority = await createCooperativeProcessGroupAuthorityFactory().create("custody:no-start");
  assert.equal(await authority.close(), true);
  assert.equal(await authority.attachGuardian(42_001), false);
  assert.equal(await authority.killAll(), true);
  assert.equal(await authority.proveEmpty(0, () => 0), "empty");
  assert.equal(kill.mock.callCount(), 0);
});
