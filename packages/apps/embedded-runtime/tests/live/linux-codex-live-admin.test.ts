import {strict as assert} from "node:assert";
import {test} from "node:test";
import {LinuxCodexLiveAdminSetupError, setupLinuxCodexLiveAdmin} from "./linux-codex-live-admin.ts";

// Invalid administration never reaches a Pool or runtime owner. These are
// malformed-input tests, not mocked PA/RS/custody authority or live tests.
test("invalid approval erases transferred bytes and retains a retryable cleanup handle", async () => {
  const material = {token: new Uint8Array([65, 66]), accountId: new Uint8Array([67, 68])};
  let failure: LinuxCodexLiveAdminSetupError | undefined;
  try {
    await setupLinuxCodexLiveAdmin(undefined as never, undefined as never, undefined as never, material);
    assert.fail("malformed approval must fail before administrative I/O");
  } catch (error) {
    assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
    failure = error;
  }
  assert.deepEqual([...material.token, ...material.accountId], [0, 0, 0, 0]);
  assert.ok(failure);
  assert.equal(failure.directory, undefined);
  assert.equal(Object.hasOwn(failure, "cause"), false);
  // There is no owner to observe on this path, hence no fabricated deadline.
  assert.equal(await failure.cleanup(undefined as never), "released");
  assert.equal(await failure.cleanup(undefined as never), "released");
});

test("concurrent early-failure cleanup shares the retained flight", async () => {
  const material = {token: new Uint8Array([1]), accountId: new Uint8Array([2])};
  try {
    await setupLinuxCodexLiveAdmin(undefined as never, undefined as never, undefined as never, material);
    assert.fail("expected administrative setup failure");
  } catch (error) {
    assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
    const first = error.cleanup(undefined as never);
    const second = error.cleanup(undefined as never);
    assert.equal(first, second);
    assert.equal(await first, "released");
  }
});

test("approval snapshot failure erases transferred arrays despite producer slot replacement", async () => {
  const token = new Uint8Array([65, 66]);
  const accountId = new Uint8Array([67, 68]);
  const replacement = new Uint8Array([69]);
  const material = {token, accountId};
  const approval = {get binding() {
    material.token = replacement;
    material.accountId = replacement;
    throw new Error("snapshot failed");
  }};
  await assert.rejects(
    setupLinuxCodexLiveAdmin(undefined as never, approval as never, undefined as never, material),
    error => {
      assert.ok(error instanceof LinuxCodexLiveAdminSetupError);
      assert.equal(error.directory, undefined);
      return true;
    },
  );
  assert.deepEqual([...token, ...accountId], [0, 0, 0, 0]);
  assert.deepEqual([...replacement], [69]);
});
