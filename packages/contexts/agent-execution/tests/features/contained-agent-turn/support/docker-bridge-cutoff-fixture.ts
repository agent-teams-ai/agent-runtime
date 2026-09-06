import assert from "node:assert/strict";
import type {TestContext} from "node:test";
import {DockerCustodyInitRuntime} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-runtime.js";
import {DockerCustodyFrameDecoder, encodeDockerCustodyFrame, type DockerCustodyProtocolMessage} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {FakeSyscalls} from "../docker-custody-init-test-fixture.ts";
import {codexChannelFixture} from "./docker-codex-channel-fixture.ts";
import {fixture, deferred, initOptions, providerExec} from "./docker-provider-process-fixture.ts";

export {deferred, tick} from "./docker-provider-process-fixture.ts";
export const stdoutTail = Buffer.from([0, 255]);
export const stderrTail = Buffer.from([254, 10]);
type WriteHook = (kind: DockerCustodyProtocolMessage["kind"]) => void | Promise<void>;

const collect = async (stream: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {chunks.push(chunk);}
  return Buffer.concat(chunks);
};

/** Actual bridge, lifecycle, journal, Docker channel and init runtime. Only the
 * Engine, unconnected socket peer and provider syscalls are disposable fakes. */
export const cutoffFixture = async (t: TestContext) => {
  const f = fixture(); const syscalls = new FakeSyscalls(); const releases: Array<() => void> = [];
  const abort = new AbortController();
  const controls = {current: true, beforeWrite: undefined as WriteHook | undefined,
    afterWrite: undefined as WriteHook | undefined, onStop: async () => {}};
  const identity = initOptions().authority.expectedIdentity;
  syscalls.observeIdentity = () => identity;
  syscalls.writeProviderOutput = (stream, bytes) => {
    f.channel.outputBytes(stream, bytes); return {committedBytes: bytes.byteLength, status: "accepted"};
  };
  const runtime = new DockerCustodyInitRuntime({allowedEnvironmentNames: [], executablePath: "/synthetic/provider",
    executableSha256: providerExec.executableSha256, observedIdentity: identity, syscalls,
    maximumStderrBytes: 100, maximumStdoutBytes: 100, maximumStdinBytes: 200_000,
    maximumProviderRuntimeMs: 30_000, shutdownGraceMs: 50,
    writeControl: message => {f.channel.push(message); return "accepted";}});
  f.channel.onMessage = async message => {
    runtime.receiveControlBytes(encodeDockerCustodyFrame(message)); await controls.afterWrite?.(message.kind);
  };
  const channel = codexChannelFixture(f.channel, () => {});
  const attach = f.engine.attachCustody.bind(f.engine);
  f.engine.attachCustody = async authority => {
    await attach(authority);
    return {...channel, async write(bytes, assertAdmission) {
      const [message] = new DockerCustodyFrameDecoder().push(bytes); assert.ok(message);
      await controls.beforeWrite?.(message.kind); await channel.write(bytes, assertAdmission);
    }};
  };
  const stop = f.engine.stop.bind(f.engine);
  f.engine.stop = async authority => {
    f.events.push("stop-entered"); await controls.onStop(); await stop(authority); f.events.push("stopped");
  };
  const a = await f.launch(); a.input.init.isCurrentGeneration = () => controls.current;
  a.input.call = {...a.input.call, signal: abort.signal};
  t.after(async () => {for (const release of releases) {release();} await a.contain(); await channel.close();});
  const process = await f.registry.open(a.input);
  let settled = false;
  const observations = Promise.allSettled([collect(process.stdout), collect(process.stderr), process.waitForExit()]);
  void observations.then(() => {settled = true; return;});
  const tail = () => {
    f.events.push("tail");
    assert.equal(runtime.acceptProviderOutput(syscalls.stdoutHandle, stdoutTail), "accepted");
    syscalls.rootExits.push({handle: syscalls.providerRootHandle, exitCode: 17, signal: null}); runtime.tick();
    assert.equal(runtime.acceptProviderOutput(syscalls.stderrHandle, stderrTail), "accepted");
    runtime.closeProviderOutput(syscalls.stdoutHandle); runtime.closeProviderOutput(syscalls.stderrHandle); f.channel.end();
  };
  const holdWrite = (frame = 1) => {
    const entered = deferred(); const release = deferred(); let count = 0;
    controls.beforeWrite = async kind => {
      if ((kind === "provider-input" || kind === "provider-input-eof") && ++count === frame) {
        entered.resolve(); await release.promise;
      }
    };
    releases.push(() => {release.resolve();}); return {entered, release};
  };
  return {...f, ...a, process, controls, syscalls, runtime, releases, abort, observations, settled: () => settled, tail, holdWrite};
};
