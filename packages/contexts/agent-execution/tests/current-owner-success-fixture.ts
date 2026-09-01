type Message = Record<string, any>;

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #buffer: Uint8Array[] = [];
  readonly #waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
  #ended = false;
  readonly #onDrain: () => void;

  public constructor(onDrain: () => void) {this.#onDrain = onDrain;}

  public end(): void {
    this.#ended = true;
    if (this.#waiters.length > 0) {this.#onDrain();}
    for (const waiter of this.#waiters.splice(0)) {waiter({done: true, value: undefined});}
  }

  public push(message: Message): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {this.#buffer.push(bytes);} else {waiter({done: false, value: bytes});}
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {next: async () => {
      const buffered = this.#buffer.shift();
      if (buffered !== undefined) {return {done: false, value: buffered};}
      if (this.#ended) {this.#onDrain(); return {done: true, value: undefined};}
      return new Promise(resolve => {this.#waiters.push(resolve);});
    }};
  }
}

interface HostLifecycle {
  finalityAccepted: boolean;
  guardianStopped: boolean;
  protocolTerminal: boolean;
  providerExitObserved: boolean;
  started: boolean;
  stderrDrained: boolean;
  stdinClosed: boolean;
  stdoutDrained: boolean;
}

type ErrorListener = (error: Error) => void;
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

class DeterministicSdkProcess {
  public exitCode: number | null = null;
  public readonly killed = false;
  public readonly signalCode = null;
  public readonly stdin = {};
  public readonly stdout = {};
  readonly #exitListeners = new Set<ExitListener>();
  readonly #lifecycle: HostLifecycle;

  public constructor(lifecycle: HostLifecycle) {this.#lifecycle = lifecycle;}

  public markExited(): void {
    if (this.exitCode !== null) {return;}
    this.exitCode = 0;
    this.#lifecycle.providerExitObserved = true;
    for (const listener of this.#exitListeners) {listener(0, null);}
    this.#exitListeners.clear();
  }

  public kill(_signal: NodeJS.Signals): boolean {return true;}
  public off(_event: "error", _listener: ErrorListener): void;
  public off(event: "exit", listener: ExitListener): void;
  public off(event: string, listener: ErrorListener | ExitListener): void {
    if (event === "exit") {this.#exitListeners.delete(listener as ExitListener);}
  }
  public on(_event: "error", _listener: ErrorListener): void;
  public on(event: "exit", listener: ExitListener): void;
  public on(event: string, listener: ErrorListener | ExitListener): void {
    if (event === "exit") {this.#exitListeners.add(listener as ExitListener);}
  }
  public once(_event: "error", _listener: ErrorListener): void;
  public once(event: "exit", listener: ExitListener): void;
  public once(event: string, listener: ErrorListener | ExitListener): void {
    if (event === "exit") {this.#exitListeners.add(listener as ExitListener);}
  }
}

const generatedTurn = (id: string, status: "completed" | "inProgress") => ({
  completedAt: status === "inProgress" ? null : 1,
  durationMs: status === "inProgress" ? null : 1,
  error: null, id, items: [], itemsView: "full", startedAt: 1, status,
});

class CodexProtocolProcess {
  readonly custodyRef: string;
  readonly stderr: AsyncByteQueue;
  readonly stdout: AsyncByteQueue;
  readonly workspaceAuthorityPath = "/proc/self/fd/4" as const;
  readonly #lifecycle: HostLifecycle;
  readonly #observeProviderExit: () => void;
  readonly #plan: Message;

  public constructor(
    custodyRef: string,
    plan: Message,
    lifecycle: HostLifecycle,
    observeProviderExit: () => void,
  ) {
    this.custodyRef = custodyRef;
    this.#lifecycle = lifecycle;
    this.#observeProviderExit = observeProviderExit;
    this.#plan = plan;
    this.stderr = new AsyncByteQueue(() => {this.#lifecycle.stderrDrained = true;});
    this.stdout = new AsyncByteQueue(() => {this.#lifecycle.stdoutDrained = true;});
    this.stderr.end();
  }

  public async closeInput(): Promise<void> {
    this.#lifecycle.stdinClosed = true;
    this.stdout.end();
  }
  public async waitForExit() {
    if (!this.#lifecycle.stdinClosed || !this.#lifecycle.stdoutDrained || !this.#lifecycle.stderrDrained) {
      throw new Error("provider exit cannot precede the deterministic stdio fence");
    }
    this.#observeProviderExit();
    return {code: 0, signal: null};
  }

  public completeClaudeOutput(): void {
    this.#lifecycle.protocolTerminal = true;
    this.#lifecycle.stdoutDrained = true;
    this.#lifecycle.stderrDrained = true;
  }

  public closeClaudeInput(): void {
    if (!this.#lifecycle.protocolTerminal || !this.#lifecycle.stdoutDrained || !this.#lifecycle.stderrDrained) {
      throw new Error("Claude close cannot precede terminal output drain");
    }
    this.#lifecycle.stdinClosed = true;
    this.#observeProviderExit();
  }

  public async write(bytes: Uint8Array): Promise<void> {
    for (const line of Buffer.from(bytes).toString("utf8").trim().split("\n")) {
      if (line.length > 0) {this.#respond(JSON.parse(line) as Message);}
    }
  }

  #emit(message: Message): void {this.stdout.push(message);}

  #respond(message: Message): void {
    const codexHome = this.#plan.codexHome as string;
    const permissionProfileId = this.#plan.permissionProfileId as string;
    const workspaceRef = this.#plan.workspaceRef as string;
    const permissionProfile = {
      extends: ":workspace",
      file_system: {entries: [{access: "deny", path: codexHome}]},
      network: {enabled: false},
    };
    if (message.method === "initialize") {
      this.#emit({id: message.id, result: {codexHome, platformFamily: "unix", platformOs: "linux", userAgent: "codex/0.150.1"}});
    } else if (message.method === "config/read") {
      this.#emit({id: message.id, result: {
        config: {default_permissions: permissionProfileId, permissions: {[permissionProfileId]: permissionProfile}},
        layers: [
          {config: {}, disabledReason: null, name: {file: "/opt/codex/defaults.toml", type: "packagedDefaults"}, version: "1"},
          {config: {permissions: {[permissionProfileId]: permissionProfile}}, disabledReason: null,
            name: {file: `${codexHome}/config.toml`, profile: null, type: "user"}, version: "2"},
          {config: {default_permissions: permissionProfileId}, disabledReason: null,
            name: {type: "sessionFlags"}, version: "3"},
        ],
        origins: {
          default_permissions: {name: {type: "sessionFlags"}, version: "3"},
          permissions: {name: {file: `${codexHome}/config.toml`, profile: null, type: "user"}, version: "2"},
        },
      }});
    } else if (message.method === "permissionProfile/list") {
      this.#emit({id: message.id, result: {data: [{allowed: true, description: null, id: permissionProfileId}], nextCursor: null}});
    } else if (message.method === "thread/start") {
      this.#emit({method: "thread/settings/updated", params: {threadId: "thread:pg-success", threadSettings: {
        activePermissionProfile: {extends: ":workspace", id: permissionProfileId}, approvalPolicy: "never", cwd: workspaceRef,
        sandboxPolicy: {networkAccess: false, type: "readOnly"},
      }}});
      this.#emit({id: message.id, result: {thread: {id: "thread:pg-success"}}});
    } else if (message.method === "turn/start") {
      const turn = generatedTurn("turn:pg-success", "inProgress");
      this.#emit({id: message.id, result: {turn}});
      this.#emit({method: "turn/started", params: {threadId: "thread:pg-success", turn}});
      this.#emit({method: "turn/completed", params: {
        threadId: "thread:pg-success", turn: generatedTurn("turn:pg-success", "completed"),
      }});
      this.#lifecycle.protocolTerminal = true;
    }
  }
}

export class DeterministicCurrentOwnerHost {
  readonly plans: Message[] = [];
  readonly #children = new Map<string, DeterministicSdkProcess>();
  readonly #lifecycles = new Map<string, HostLifecycle>();
  readonly #processes = new Map<string, CodexProtocolProcess>();
  containments = 0;
  finalities = 0;
  releases = 0;
  reserves = 0;
  starts = 0;

  public async reserve(input: Message) {
    this.reserves += 1;
    const custodyRef = `urn:agent-runtime:host-custody:pg-success-${String(this.reserves)}`;
    const lifecycle: HostLifecycle = {
      finalityAccepted: false, guardianStopped: false, protocolTerminal: false,
      providerExitObserved: false, started: false, stderrDrained: false,
      stdinClosed: false, stdoutDrained: false,
    };
    this.plans.push(input.launchPlan);
    this.#lifecycles.set(custodyRef, lifecycle);
    const child = new DeterministicSdkProcess(lifecycle);
    this.#children.set(custodyRef, child);
    this.#processes.set(custodyRef, new CodexProtocolProcess(
      custodyRef, input.launchPlan, lifecycle, () => {child.markExited();},
    ));
    return Object.freeze({custodyRef});
  }

  public async open() {throw new Error("deterministic current-owner fixture must reserve");}
  public start(custodyRef: string) {
    const lifecycle = this.#lifecycles.get(custodyRef);
    if (lifecycle === undefined || lifecycle.started) {throw new Error("unknown or already started deterministic custody");}
    lifecycle.started = true;
    this.starts += 1;
    return this.#children.get(custodyRef)!;
  }
  public get(custodyRef: string) {return this.#processes.get(custodyRef);}
  public evidence(custodyRef: string) {
    const lifecycle = this.#lifecycles.get(custodyRef);
    if (lifecycle === undefined) {return;}
    const started = lifecycle.started;
    const finalized = lifecycle.finalityAccepted;
    return Object.freeze({
      closure: {limitations: Object.freeze([]), profile: "strict-linux-cgroup-v2",
        status: finalized ? "closed" : started ? "unproven" : "not-started"},
      fingerprint: {
        argumentsSha256: "1".repeat(64), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
        environmentKeys: Object.freeze([]), executablePathSha256: "2".repeat(64), executableSha256: "3".repeat(64),
        fingerprintSha256: "4".repeat(64), intentMode: "analysis", planSha256: "5".repeat(64),
        privatePathEnvironmentKeys: Object.freeze([]), privateRootPathSha256: "6".repeat(64),
        providerBindingSha256: "7".repeat(64), spawnMode: "sdk-delegated", workspaceSha256: "8".repeat(64),
      },
      guardianExit: lifecycle.guardianStopped ? {code: 0, signal: null, status: "observed"} : {status: "unobserved"},
      identity: started ? {
        binarySha256: "3".repeat(64), childProcessInstanceSha256: "9".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), pgid: 101, pid: 102,
        planSha256: "5".repeat(64), proofRef: "proof:pg-success", status: "proved",
      } : {
        binarySha256: "0".repeat(64), childProcessInstanceSha256: "0".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), planSha256: "0".repeat(64), status: "not-started",
      },
      privateRoot: {identitySha256: "b".repeat(64), status: finalized ? "deleted" : "active"},
      providerExit: lifecycle.providerExitObserved
        ? {code: 0, signal: null, status: "observed"} : {status: started ? "unobserved" : "not-started"},
      sealed: finalized, spawn: started ? "acknowledged" : "never-started",
      stderr: {bytes: 0, sha256: "0".repeat(64),
        status: lifecycle.stderrDrained ? "complete" : started ? "incomplete" : "not-started"},
      stdout: {bytes: 0, sha256: "0".repeat(64),
        status: lifecycle.stdoutDrained ? "complete" : started ? "incomplete" : "not-started"},
    });
  }
  public completeClaudeOutput(): void {
    const process = this.#processes.get(this.#latestCustodyRef());
    if (process === undefined) {throw new Error("Claude deterministic process is unavailable");}
    process.completeClaudeOutput();
  }
  public closeClaudeInput(): void {
    const process = this.#processes.get(this.#latestCustodyRef());
    if (process === undefined) {throw new Error("Claude deterministic process is unavailable");}
    process.closeClaudeInput();
  }
  public async requestContainment(input: Message) {
    this.containments += 1;
    const custodyRef = input.custodyRef as string;
    const lifecycle = this.#lifecycles.get(custodyRef);
    if (lifecycle === undefined || !lifecycle.started || !lifecycle.protocolTerminal ||
        !lifecycle.providerExitObserved || !lifecycle.stdinClosed ||
        !lifecycle.stdoutDrained || !lifecycle.stderrDrained) {
      return {evidenceRef: "evidence:pg-success-finality-incomplete", kind: "unproven" as const};
    }
    lifecycle.guardianStopped = true;
    lifecycle.finalityAccepted = true;
    this.finalities += 1;
    return {kind: "contained" as const, receiptRef: "receipt:pg-success"};
  }
  public async release() {this.releases += 1; return {kind: "released" as const};}

  #latestCustodyRef(): string {
    const custodyRef = [...this.#processes.keys()].at(-1);
    if (custodyRef === undefined) {throw new Error("deterministic custody is unavailable");}
    return custodyRef;
  }
}

export const successfulClaudeQuery = (host: DeterministicCurrentOwnerHost, workspaceRef: string) => (input: Message) => {
  const plan = host.plans.at(-1)!;
  input.options.spawnClaudeCodeProcess({
    args: [...plan.arguments], command: "/synthetic/claude", cwd: input.options.cwd,
    env: {...plan.environment}, signal: new AbortController().signal,
  });
  return {close: () => {host.closeClaudeInput();}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {
    yield {is_error: false, result: "OK", session_id: "session:pg-success",
      subtype: "success" as const, type: "result" as const, uuid: "result:pg-success"};
    host.completeClaudeOutput();
  }};
};
