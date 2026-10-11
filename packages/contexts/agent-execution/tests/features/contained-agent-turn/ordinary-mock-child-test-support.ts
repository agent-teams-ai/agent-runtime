import {ChildProcess} from "node:child_process";
import {PassThrough} from "node:stream";
import type {TestContext} from "node:test";

export type MockChild = ChildProcess & {readonly stdout: PassThrough; readonly stderr: PassThrough};

/** A child process with synthetic pipes; spawn is mocked by the caller, so nothing is started. */
export function createMockChild(): MockChild {
  const child = new ChildProcess();
  // The typings make pid read-only; a real child receives it from spawn.
  Object.defineProperty(child, "pid", {value: 424242, configurable: true});
  Object.assign(child, {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()});
  // The pipes were assigned above; the typings only declare them nullable.
  return child as MockChild;
}

/** Makes the owner-uid check pass on any platform. */
export function mockProcessUid(t: TestContext): void {
  // getuid is optional in the typings (absent on Windows); the mock needs a method-typed receiver.
  t.mock.method(process as {getuid(): number}, "getuid", () => 1000);
}
