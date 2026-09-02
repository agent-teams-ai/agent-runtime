import {
  DOCKER_CUSTODY_INIT_PROTOCOL,
  type DockerCustodyChildSignal,
  type DockerCustodyHostHandshake,
  type DockerCustodyIdentity,
  type DockerCustodyInitMessage,
  type DockerCustodyProviderExecRequest,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-protocol.js";
import {
  DockerCustodyInitRuntime,
  type DockerCustodyInitSyscalls,
  type DockerCustodyOutputWriteResult,
  type DockerCustodyProviderOutputHandle,
  type DockerCustodyProviderSpawn,
  type DockerCustodyProviderRootHandle,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/init/docker-custody-init-runtime.js";

export const digest = (digit: string): string => digit.repeat(64);
export const framePayload = (payload: Buffer): Buffer => {
  const frame = Buffer.alloc(payload.byteLength + 4); frame.writeUInt32BE(payload.byteLength, 0); payload.copy(frame, 4); return frame;
};
export const identity: DockerCustodyIdentity = Object.freeze({
  containerImageSha256: digest("a"),
  initBinarySha256: digest("b"),
  privateRootIdentity: "private-root:attempt-1",
  protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
  securityProfileIdentity: "security-profile:strict-v1",
  workspaceIdentity: "workspace:attempt-1",
});
export const handshake: DockerCustodyHostHandshake = Object.freeze({
  expectedIdentity: identity,
  kind: "host-handshake",
  launchFingerprintSha256: digest("c"),
  nonce: "host-nonce:one",
  protocol: DOCKER_CUSTODY_INIT_PROTOCOL,
});
export const request = (overrides: Partial<DockerCustodyProviderExecRequest> = {}): DockerCustodyProviderExecRequest => Object.freeze({
  argv: Object.freeze(["provider", "serve"]),
  environment: Object.freeze([Object.freeze({ name: "HOME", value: "/private/home" })]),
  executableSha256: digest("d"),
  executableSlot: "provider-entrypoint",
  gid: 10001,
  handshakeNonce: "host-nonce:one",
  kind: "provider-exec",
  launchFingerprintSha256: digest("c"),
  requestId: "exec-request:one",
  uid: 10001,
  wallDeadlineUnixMs: 20_000,
  ...overrides,
});

export const opaqueRootHandle = (kernelIdentity: string): DockerCustodyProviderRootHandle => {
  const handle = {};
  Object.defineProperty(handle, "kernelIdentity", {enumerable: false, value: kernelIdentity});
  return Object.freeze(handle) as unknown as DockerCustodyProviderRootHandle;
};
export const opaqueOutputHandle = (kernelIdentity: string): DockerCustodyProviderOutputHandle => {
  const handle = {};
  Object.defineProperty(handle, "kernelIdentity", {enumerable: false, value: kernelIdentity});
  return Object.freeze(handle) as unknown as DockerCustodyProviderOutputHandle;
};

export class FakeSyscalls implements DockerCustodyInitSyscalls {
  public input: Uint8Array[] = [];
  public inputOutcomes: Array<{readonly committedBytes: number; readonly status: "accepted" | "blocked" | "closed"}> = [];
  public inputStatus: "accepted" | "blocked" | "closed" = "accepted";
  public monotonic = 1_000;
  public output: Array<{ readonly bytes: Uint8Array; readonly stream: "stderr" | "stdout" }> = [];
  public outputOutcomes: DockerCustodyOutputWriteResult[] = [];
  public outputStatus: "accepted" | "blocked" = "accepted";
  public readonly providerRootHandle = opaqueRootHandle("pidfd:provider-root:one");
  public rootObservations: DockerCustodyProviderRootHandle[] = [];
  public rootExits: Array<{readonly exitCode: number | null; readonly handle: DockerCustodyProviderRootHandle; readonly signal: DockerCustodyChildSignal | null}> = [];
  public rootPid = 41;
  public signalFailure = false;
  public signals: Array<{ readonly handle: DockerCustodyProviderRootHandle; readonly signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2" }> = [];
  public spawnOutcome: "ambiguous-error" | "not-started" | "started" = "started";
  public spawns: DockerCustodyProviderSpawn[] = [];
  public readonly stderrHandle = opaqueOutputHandle("pipe:provider-root:one:stderr");
  public readonly stdoutHandle = opaqueOutputHandle("pipe:provider-root:one:stdout");
  public wall = 10_000;

  public assertNoNewPrivileges(): void {}
  public assertDirectChildOfContainerInit(): void {}
  public closeProviderInput(): void {this.inputStatus = "closed";}
  public monotonicNowMs(): number {return this.monotonic;}
  public observeProviderRootExit(handle: DockerCustodyProviderRootHandle): {readonly exitCode: number | null; readonly signal: DockerCustodyChildSignal | null} | null {
    this.rootObservations.push(handle);
    const index = this.rootExits.findIndex(item => item.handle === handle);
    if (index < 0) {return null;}
    const [observed] = this.rootExits.splice(index, 1); return observed ?? null;
  }
  public observeIdentity(): DockerCustodyIdentity {return identity;}
  public signalProviderRoot(handle: DockerCustodyProviderRootHandle, signal: "SIGHUP" | "SIGINT" | "SIGKILL" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2"): "sent" {
    this.signals.push({ handle, signal });
    if (this.signalFailure) {throw new Error("synthetic signal failure");}
    return "sent";
  }
  public spawnProvider(spawn: DockerCustodyProviderSpawn): ReturnType<DockerCustodyInitSyscalls["spawnProvider"]> {
    this.spawns.push(spawn);
    if (this.spawnOutcome === "ambiguous-error") {throw new Error("synthetic ambiguous spawn failure");}
    if (this.spawnOutcome === "not-started") {return { kind: "not-started" };}
    return {handle: this.providerRootHandle, kind: "started", pid: this.rootPid, stderr: this.stderrHandle, stdout: this.stdoutHandle};
  }
  public wallNowUnixMs(): number {return this.wall;}
  public writeProviderInput(bytes: Uint8Array): {readonly committedBytes: number; readonly status: "accepted" | "blocked" | "closed"} {
    const result = this.inputOutcomes.shift() ??
      {committedBytes: this.inputStatus === "closed" ? 0 : bytes.byteLength, status: this.inputStatus};
    if (result.committedBytes > 0 && result.committedBytes <= bytes.byteLength) {
      this.input.push(bytes.subarray(0, result.committedBytes).slice());
    }
    return result;
  }
  public writeProviderOutput(stream: "stderr" | "stdout", bytes: Uint8Array): DockerCustodyOutputWriteResult {
    const result = this.outputOutcomes.shift() ?? (this.outputStatus === "accepted"
      ? {committedBytes: bytes.byteLength, status: "accepted" as const}
      : {committedBytes: 0, status: "blocked" as const});
    if (Number.isSafeInteger(result.committedBytes) && result.committedBytes > 0 && result.committedBytes <= bytes.byteLength) {
      this.output.push({bytes: bytes.subarray(0, result.committedBytes).slice(), stream});
    }
    return result;
  }
}

export const fixture = (changes: {
  readonly syscalls?: FakeSyscalls;
  readonly writeControl?: (message: DockerCustodyInitMessage) => "accepted" | "blocked";
} = {}) => {
  const syscalls = changes.syscalls ?? new FakeSyscalls();
  const control: DockerCustodyInitMessage[] = [];
  const runtime = new DockerCustodyInitRuntime({
    allowedEnvironmentNames: Object.freeze(["HOME", "LANG"]),
    executablePath: "/immutable/provider",
    executableSha256: digest("d"),
    maximumStderrBytes: 8,
    maximumStdinBytes: 8,
    maximumStdoutBytes: 8,
    maximumProviderRuntimeMs: 30_000,
    observedIdentity: identity,
    shutdownGraceMs: 50,
    syscalls,
    writeControl: changes.writeControl ?? (message => {control.push(message); return "accepted";}),
  });
  return { control, runtime, syscalls };
};
export const containmentReasons = (control: readonly DockerCustodyInitMessage[]): string[] => control
  .filter((message): message is Extract<DockerCustodyInitMessage, {readonly kind: "container-containment-request"}> =>
    message.kind === "container-containment-request")
  .map(message => message.reason);
