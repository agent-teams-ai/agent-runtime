type Message = Record<string, any>;

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #buffer: Uint8Array[] = [];
  readonly #waiters: ((value: IteratorResult<Uint8Array>) => void)[] = [];
  #ended = false;

  public end(): void {
    this.#ended = true;
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
      if (this.#ended) {return {done: true, value: undefined};}
      return new Promise(resolve => {this.#waiters.push(resolve);});
    }};
  }
}

const generatedTurn = (id: string, status: "completed" | "inProgress") => ({
  completedAt: status === "inProgress" ? null : 1,
  durationMs: status === "inProgress" ? null : 1,
  error: null, id, items: [], itemsView: "full", startedAt: 1, status,
});

class CodexProtocolProcess {
  readonly custodyRef: string;
  readonly stderr = new AsyncByteQueue();
  readonly stdout = new AsyncByteQueue();
  readonly #plan: Message;

  public constructor(custodyRef: string, plan: Message) {
    this.custodyRef = custodyRef;
    this.#plan = plan;
    this.stderr.end();
  }

  public async closeInput(): Promise<void> {this.stdout.end();}
  public async waitForExit() {return {code: 0, signal: null};}

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
    }
  }
}

export class DeterministicCurrentOwnerHost {
  readonly plans: Message[] = [];
  readonly #processes = new Map<string, CodexProtocolProcess>();
  containments = 0;
  releases = 0;
  reserves = 0;
  starts = 0;

  public async reserve(input: Message) {
    this.reserves += 1;
    const custodyRef = `urn:agent-runtime:host-custody:pg-success-${String(this.reserves)}`;
    this.plans.push(input.launchPlan);
    this.#processes.set(custodyRef, new CodexProtocolProcess(custodyRef, input.launchPlan));
    return Object.freeze({custodyRef});
  }

  public async open() {throw new Error("deterministic current-owner fixture must reserve");}
  public start(custodyRef: string) {
    if (!this.#processes.has(custodyRef)) {throw new Error("unknown deterministic custody");}
    this.starts += 1;
    return Object.freeze({
      exitCode: null, killed: false, signalCode: null, stdin: {}, stdout: {}, kill: () => true,
      off: () => {}, on: () => {}, once: () => {},
    });
  }
  public get(custodyRef: string) {return this.#processes.get(custodyRef);}
  public evidence(custodyRef: string) {
    if (!this.#processes.has(custodyRef)) {return;}
    const started = this.starts > 0;
    return Object.freeze({
      closure: {limitations: Object.freeze([]), profile: "strict-linux-cgroup-v2", status: started ? "closed" : "not-started"},
      fingerprint: {
        argumentsSha256: "1".repeat(64), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
        environmentKeys: Object.freeze([]), executablePathSha256: "2".repeat(64), executableSha256: "3".repeat(64),
        fingerprintSha256: "4".repeat(64), intentMode: "analysis", planSha256: "5".repeat(64),
        privatePathEnvironmentKeys: Object.freeze([]), privateRootPathSha256: "6".repeat(64),
        providerBindingSha256: "7".repeat(64), spawnMode: "sdk-delegated", workspaceSha256: "8".repeat(64),
      },
      guardianExit: started ? {code: 0, signal: null, status: "observed"} : {status: "unobserved"},
      identity: started ? {
        binarySha256: "3".repeat(64), childProcessInstanceSha256: "9".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), pgid: 101, pid: 102,
        planSha256: "5".repeat(64), proofRef: "proof:pg-success", status: "proved",
      } : {
        binarySha256: "0".repeat(64), childProcessInstanceSha256: "0".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), planSha256: "0".repeat(64), status: "not-started",
      },
      privateRoot: {identitySha256: "b".repeat(64), status: started ? "deleted" : "active"},
      providerExit: started ? {code: 0, signal: null, status: "observed"} : {status: "not-started"},
      sealed: true, spawn: started ? "acknowledged" : "never-started",
      stderr: {bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : "not-started"},
      stdout: {bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : "not-started"},
    });
  }
  public async requestContainment() {
    this.containments += 1;
    return {kind: "contained" as const, receiptRef: "receipt:pg-success"};
  }
  public async release() {this.releases += 1; return {kind: "released" as const};}
}

export const successfulClaudeQuery = (host: DeterministicCurrentOwnerHost, workspaceRef: string) => (input: Message) => {
  const plan = host.plans.at(-1)!;
  input.options.spawnClaudeCodeProcess({
    args: [...plan.arguments], command: "/synthetic/claude", cwd: workspaceRef,
    env: {...plan.environment}, signal: new AbortController().signal,
  });
  return {close: () => {}, interrupt: async () => {}, async *[Symbol.asyncIterator]() {
    yield {is_error: false, result: "OK", session_id: "session:pg-success",
      subtype: "success" as const, type: "result" as const, uuid: "result:pg-success"};
  }};
};
