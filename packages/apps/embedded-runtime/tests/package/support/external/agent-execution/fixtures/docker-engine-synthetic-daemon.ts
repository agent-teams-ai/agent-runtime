import { DockerEngineError } from "@agent-teams/agent-execution/composition";
import { PassThrough } from "node:stream";
import type { DockerEngineCall } from "@agent-teams/agent-execution/composition";
import { CONTAINER, DAEMON_BOOT, HOST_BOOT, IMAGE, NONCE, SECCOMP_JSON } from "./docker-engine-test-fixture.ts";
import { jsonResponse, multiplex } from "../../../../../support/external/agent-execution/features/contained-agent-turn/docker-engine-transport-test-fixture.ts";
interface MutationPlan {
  readonly body?: unknown;
  readonly effect: boolean;
  readonly failure?: "disconnect";
  readonly statusCode: number;
}

interface SyntheticDaemon {
  readonly bodies: unknown[];
  readonly client: {
    buffered(input: { readonly beforeWrite?: () => void; readonly body?: Uint8Array; readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: Uint8Array; readonly contentType: string; readonly statusCode: number }>;
    endpointIdentity(): Promise<{ readonly canonicalSocketPath: string; readonly daemonBootGenerationSha256: string; readonly hostBootGenerationSha256: string }>;
    hijack(input: {readonly call: DockerEngineCall; readonly path: string}): Promise<{
      readonly input: PassThrough; readonly output: AsyncIterable<Uint8Array>; close(): Promise<void>;
    }>;
    stream(input: { readonly call: DockerEngineCall; readonly method: "DELETE" | "GET" | "POST"; readonly path: string }): Promise<{ readonly body: AsyncIterable<Uint8Array>; readonly contentType: string; readonly statusCode: number }>;
  };
  daemonBoot: string;
  extraInfoField: boolean;
  infoCgroupVersion: unknown;
  infoEngineVersion: unknown;
  inspectTransform: ((value: Record<string, unknown>) => void) | undefined;
  readonly hijackCloseCount: number;
  logLeavesRunning: boolean;
  loseNextCreate: boolean;
  oversizeNextCreate: boolean;
  mutationPlan: MutationPlan | undefined;
  rawCreateBody: Uint8Array | undefined;
  failHijack(): void;
  pauseNextMutationWrite(at: "after" | "before"): { readonly reached: Promise<void>; release(): void };
  readonly routes: string[];
}

export const syntheticDaemon = (): SyntheticDaemon => {
  const routes: string[] = [];
  const bodies: unknown[] = [];
  const state = {
    daemonBoot: DAEMON_BOOT,
    extraInfoField: false,
    infoCgroupVersion: "2" as unknown,
    infoEngineVersion: "29.6.1" as unknown,
    inspectTransform: undefined as ((value: Record<string, unknown>) => void) | undefined,
    logLeavesRunning: false,
    loseNextCreate: false,
    oversizeNextCreate: false,
    mutationPlan: undefined as MutationPlan | undefined,
    present: false,
    rawCreateBody: undefined as Uint8Array | undefined,
    running: false,
    terminal: false,
  };
  let hijackCloseCount = 0;
  let hijackInput: PassThrough | undefined;
  let mutationBarrier: {
    readonly at: "after" | "before";
    readonly reached: () => void;
    readonly released: Promise<void>;
  } | undefined;
  let created: Record<string, unknown> | undefined;
  const inspect = (): Record<string, unknown> => {
    const body = created ?? {};
    const host = body.HostConfig as Record<string, unknown> | undefined;
    const configuredMounts = Array.isArray(host?.Mounts) ? host.Mounts as Array<Record<string, unknown>> : [];
    const value: Record<string, unknown> = {
      AppArmorProfile: "agent-runtime-contained-turn-v1",
      Config: {
        AttachStderr: body.AttachStderr,
        AttachStdin: body.AttachStdin,
        AttachStdout: body.AttachStdout,
        Cmd: body.Cmd,
        Entrypoint: body.Entrypoint,
        Env: body.Env,
        Image: IMAGE,
        Labels: body.Labels,
        NetworkDisabled: body.NetworkDisabled,
        OpenStdin: body.OpenStdin,
        StdinOnce: body.StdinOnce,
        StopSignal: body.StopSignal,
        Tty: body.Tty,
        User: "65532:65532",
        WorkingDir: "/workspace",
      },
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CgroupParent: host?.CgroupParent,
        CgroupnsMode: "private",
        CpuPeriod: 0,
        Init: true,
        IpcMode: "private",
        Memory: 100_663_296,
        MemorySwap: 100_663_296,
        Mounts: host?.Mounts,
        NanoCpus: 500_000_000,
        NetworkMode: "ar-operation-gateway",
        OomKillDisable: false,
        PidMode: "",
        PidsLimit: 32,
        Privileged: false,
        ReadonlyRootfs: true,
        RestartPolicy: { MaximumRetryCount: 0, Name: "no" },
        SecurityOpt: [
          "no-new-privileges=true",
          `seccomp=${SECCOMP_JSON}`,
          "apparmor=agent-runtime-contained-turn-v1",
        ],
        StorageOpt: { size: "33554432" },
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16777216,mode=1777" },
      },
      Id: CONTAINER,
      Mounts: configuredMounts.map(mount => ({
        Destination: mount.Target,
        Propagation: "rprivate",
        RW: mount.ReadOnly !== true,
        Source: mount.Source,
        Type: "bind",
      })),
      Name: `/ar-turn-${(body.Labels as Record<string, unknown> | undefined)?.["com.agent-runtime.operation-nonce-sha256"] ?? NONCE}`,
      State: {
        Dead: false,
        Error: "",
        ExitCode: state.terminal ? 0 : 0,
        FinishedAt: state.terminal ? "2026-01-01T00:00:01Z" : "0001-01-01T00:00:00Z",
        OOMKilled: false,
        Paused: false,
        Pid: state.running ? 4242 : 0,
        Restarting: false,
        Running: state.running,
        StartedAt: state.running || state.terminal ? "2026-01-01T00:00:00Z" : "0001-01-01T00:00:00Z",
        Status: state.running ? "running" : state.terminal ? "exited" : "created",
      },
    };
    state.inspectTransform?.(value);
    return value;
  };
  const applyMutation = (path: string): void => {
    if (path.includes("/start")) {state.running = true; state.terminal = false;}
    else if (path.includes("/stop") || path.includes("/kill")) {state.running = false; state.terminal = true;}
    else if (path.includes("?force=")) {state.present = false;}
  };
  const client = {
    async buffered(request: {
      readonly beforeWrite?: () => void;
      readonly body?: Uint8Array;
      readonly method: string;
      readonly path: string;
    }) {
      routes.push(`${request.method} ${request.path}`);
      if (request.path === "/v1.47/info") {
        const value: Record<string, unknown> = {
          CgroupDriver: "systemd",
          CgroupVersion: state.infoCgroupVersion,
          Driver: "overlay2",
          ID: "persistent-synthetic-daemon",
          ServerVersion: state.infoEngineVersion,
        };
        if (state.extraInfoField) {value.Unexpected = true;}
        return jsonResponse(200, value);
      }
      if (request.method === "POST" && request.path.startsWith("/v1.47/containers/create?name=")) {
        const body = JSON.parse(Buffer.from(request.body ?? []).toString("utf8")) as Record<string, unknown>;
        bodies.push(body);
        created = body;
        state.present = true;
        state.running = false;
        state.terminal = false;
        const plan = state.mutationPlan;
        if (plan !== undefined) {
          state.mutationPlan = undefined;
          if (plan.statusCode !== 201) {return jsonResponse(plan.statusCode, { message: "synthetic rejection" });}
        }
        if (state.loseNextCreate) {state.loseNextCreate = false; throw new DockerEngineError("daemon-disconnected");}
        if (state.oversizeNextCreate) {
          state.oversizeNextCreate = false;
          throw new DockerEngineError("response-too-large");
        }
        if (state.rawCreateBody !== undefined) {
          const response = { body: state.rawCreateBody, contentType: "application/json", statusCode: 201 };
          state.rawCreateBody = undefined;
          return response;
        }
        return jsonResponse(201, { Id: CONTAINER, Warnings: [] });
      }
      if (request.method === "GET" && request.path.endsWith("/json")) {
        return state.present ? jsonResponse(200, inspect()) : jsonResponse(404, { message: "gone" });
      }
      if (request.path.includes("/wait?")) {return jsonResponse(200, { StatusCode: 0 });}
      const barrier = mutationBarrier;
      mutationBarrier = undefined;
      if (barrier?.at === "before") {barrier.reached(); await barrier.released;}
      request.beforeWrite?.();
      if (barrier?.at === "after") {barrier.reached(); await barrier.released;}
      const plan = state.mutationPlan ?? { effect: true, statusCode: 204 };
      state.mutationPlan = undefined;
      if (plan.effect) {applyMutation(request.path);}
      if (plan.failure === "disconnect") {throw new DockerEngineError("daemon-disconnected");}
      const body = plan.body ?? (plan.statusCode >= 400 ? { message: "synthetic rejection" } : undefined);
      return jsonResponse(plan.statusCode, body);
    },
    async endpointIdentity() {
      return {
        canonicalSocketPath: "/policy/docker.sock",
        daemonBootGenerationSha256: state.daemonBoot,
        hostBootGenerationSha256: HOST_BOOT,
      };
    },
    async hijack(request: {readonly path: string}) {
      routes.push(`POST ${request.path}`);
      const input = new PassThrough();
      hijackInput = input;
      const output = new PassThrough();
      let closed = false;
      return {close: async () => {
        if (closed) {return;}
        closed = true; hijackCloseCount += 1; input.destroy(); output.destroy();
      }, input, output};
    },
    async stream(request: { readonly method: string; readonly path: string }) {
      routes.push(`${request.method} ${request.path}`);
      const bytes = Buffer.concat([multiplex(1, Buffer.from("out")), multiplex(2, Buffer.from("err"))]);
      async function* logChunks(): AsyncIterable<Uint8Array> {
        yield bytes.subarray(0, 5);
        yield bytes.subarray(5);
        if (!state.logLeavesRunning) {state.running = false; state.terminal = true;}
      }
      return { body: logChunks(), contentType: "application/vnd.docker.raw-stream", statusCode: 200 };
    },
  };
  return {
    bodies,
    client,
    get daemonBoot() {return state.daemonBoot;},
    set daemonBoot(value: string) {state.daemonBoot = value;},
    get extraInfoField() {return state.extraInfoField;},
    set extraInfoField(value: boolean) {state.extraInfoField = value;},
    get infoEngineVersion() {return state.infoEngineVersion;},
    set infoEngineVersion(value: unknown) {state.infoEngineVersion = value;},
    get infoCgroupVersion() {return state.infoCgroupVersion;},
    set infoCgroupVersion(value: unknown) {state.infoCgroupVersion = value;},
    get hijackCloseCount() {return hijackCloseCount;},
    get inspectTransform() {return state.inspectTransform;},
    set inspectTransform(value: ((record: Record<string, unknown>) => void) | undefined) {state.inspectTransform = value;},
    get logLeavesRunning() {return state.logLeavesRunning;},
    set logLeavesRunning(value: boolean) {state.logLeavesRunning = value;},
    get loseNextCreate() {return state.loseNextCreate;},
    set loseNextCreate(value: boolean) {state.loseNextCreate = value;},
    get oversizeNextCreate() {return state.oversizeNextCreate;},
    set oversizeNextCreate(value: boolean) {state.oversizeNextCreate = value;},
    get mutationPlan() {return state.mutationPlan;},
    set mutationPlan(value: MutationPlan | undefined) {state.mutationPlan = value;},
    get rawCreateBody() {return state.rawCreateBody;},
    set rawCreateBody(value: Uint8Array | undefined) {state.rawCreateBody = value;},
    failHijack() {hijackInput?.destroy(new Error("synthetic hijack failure"));},
    pauseNextMutationWrite(at: "after" | "before") {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>(resolve => {reached = resolve;});
      const released = new Promise<void>(resolve => {release = resolve;});
      mutationBarrier = {at, reached, released};
      return {reached: reachedPromise, release};
    },
    routes,
  };
};
