import assert from "node:assert/strict";
import test from "node:test";
import {DeferredNativeProviderProcess, DeferredNativeSdkProcess} from
  "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/deferred-native-sdk-process.js";

async function* chunks(...values: Uint8Array[]) {for (const value of values) {yield value;}}

test("native deferred output drains bounded upstream without an SDK reader", async () => {
  const provider = new DeferredNativeProviderProcess("host-ref", "/workspace");
  const sdk = new DeferredNativeSdkProcess(() => {}, provider.stdout);
  const output = Buffer.alloc(64 * 1024, 7);
  const raw = {custodyRef: "private-native-binding", workspaceAuthorityPath: "/workspace",
    stdout: chunks(output), stderr: chunks(Buffer.from("err")), write: async () => {}, closeInput: async () => {},
    waitForExit: async () => ({code: 0, signal: null})};
  provider.bind(raw); sdk.bind(raw);
  assert.equal(sdk.stdout, provider.stdout);
  await provider.drained;
  assert.equal(provider.evidence("stdout").bytes, output.length);
  assert.equal(provider.evidence("stderr").bytes, 3);
});

test("native deferred drain rejects a failed authenticated output source", async () => {
  const provider = new DeferredNativeProviderProcess("host-ref", "/workspace");
  provider.bind({custodyRef: "private-native-binding", workspaceAuthorityPath: "/workspace",
    stdout: failed(), stderr: chunks(), write: async () => {}, closeInput: async () => {},
    waitForExit: async () => ({code: null, signal: "SIGKILL" as const})});
  await assert.rejects(provider.drained, /native stream lost/u);
});

async function* failed() {yield Buffer.from("partial"); throw new Error("native stream lost");}
