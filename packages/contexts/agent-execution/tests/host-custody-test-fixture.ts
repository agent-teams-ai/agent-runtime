import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach } from "node:test";

import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";

class NodeProviderProcessCustody extends BaseNodeProviderProcessCustody {
  public override open(input: Parameters<BaseNodeProviderProcessCustody["open"]>[0]) {
    return super.open({ intentMode: "analysis", ...input });
  }
}

export const roots: string[] = [];
export const childrenToStop = new Set<number>();

export const trackSyntheticProcessGroup = (pid: number): void => {
  childrenToStop.add(pid);
};

export const syntheticResidueAuthorityFactory = Object.freeze({
  async create() {
    let guardianPid: number | undefined;
    return Object.freeze({
      async attachGuardian(pid: number) {
        guardianPid = pid;
        trackSyntheticProcessGroup(pid);
        return true;
      },
      async close() {return true;},
      async killAll() {
        if (guardianPid === undefined) {return false;}
        try {process.kill(-guardianPid, "SIGKILL"); return true;} catch {return false;}
      },
      async proveEmpty() {return "empty" as const;},
    });
  },
});

export const binding = Object.freeze({
  adapterRevision: "synthetic-adapter:one",
  binaryRevision: "node:synthetic",
  capabilityManifestRevision: "manifest:synthetic",
  credentialBindingDigest: "credential:synthetic",
  provider: "codex" as const,
  providerRouteRef: "route:synthetic",
});

export const claudeBinding = Object.freeze({
  ...binding,
  adapterRevision: "claude-sdk-adapter:test",
  binaryRevision: "node:claude-sdk-synthetic",
  provider: "claude" as const,
});

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export const disposableRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-host-custody-")));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const trackedPids = [...childrenToStop];
  const executionStopped = async (pid: number): Promise<boolean> => {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = statText.lastIndexOf(")");
      const state = commandEnd < 0 ? undefined : statText.slice(commandEnd + 2, commandEnd + 3);
      return state === "X" || state === "Z";
    } catch (error) {
      const code = Reflect.get(error as object, "code");
      return code === "ENOENT" || code === "ESRCH";
    }
  };
  const cleanupDeadline = performance.now() + 2_000;
  let remaining = trackedPids;
  do {
    for (const pid of remaining) {
      try {process.kill(-pid, "SIGKILL");} catch {}
      try {process.kill(pid, "SIGKILL");} catch {}
    }
    await new Promise(resolve => {setTimeout(resolve, 5);});
    const observed: number[] = [];
    for (const pid of remaining) {
      if (!await executionStopped(pid)) {observed.push(pid);}
    }
    remaining = observed;
  } while (remaining.length > 0 && performance.now() < cleanupDeadline);
  childrenToStop.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
  if (remaining.length > 0) {
    throw new Error(`synthetic Host Custody children survived cleanup: ${remaining.join(",")}`);
  }
});

const digestCache = new Map<string, Promise<string>>();
export const executableDigest = (path = process.execPath): Promise<string> => {
  const existing = digestCache.get(path);
  if (existing !== undefined) {return existing;}
  const digest = readFile(path).then(bytes => sha256(bytes));
  digestCache.set(path, digest);
  return digest;
};

export const qualifiedIdentityObserver = Object.freeze({
  async observe(input: {
    readonly binarySha256: string;
    readonly child: object;
    readonly childProcessInstanceSha256: string;
    readonly hostLifecycleGenerationSha256: string;
    readonly pgid: number;
    readonly pid: number;
    readonly planSha256: string;
  }) {
    return Object.freeze({
      child: input.child,
      childProcessInstanceSha256: input.childProcessInstanceSha256,
      pgid: input.pgid,
      pid: input.pid,
      proofRef: `synthetic-qualified-observer:${sha256(JSON.stringify([
        input.pid,
        input.pgid,
        input.binarySha256,
        input.planSha256,
        input.hostLifecycleGenerationSha256,
      ]))}`,
      status: "proved" as const,
    });
  },
});

const fixtureScript = String.raw`
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write("root:" + process.pid + ":descendant:" + child.pid + "\n");
process.stdin.on("data", chunk => process.stdout.write("echo:" + chunk));
setInterval(() => {}, 1000);
`;

const privatePathsFor = async (workspaceRef: string, provider: "claude" | "codex") => {
  const privateRootPath = join(dirname(workspaceRef), `${basename(workspaceRef)}-host-private`);
  const home = join(privateRootPath, "home");
  const temporary = join(privateRootPath, "tmp");
  const providerConfig = join(privateRootPath, "provider-config");
  await Promise.all([
    mkdir(home, { mode: 0o700, recursive: true }),
    mkdir(temporary, { mode: 0o700, recursive: true }),
    mkdir(providerConfig, { mode: 0o700, recursive: true }),
  ]);
  if (!roots.includes(privateRootPath)) {roots.push(privateRootPath);}
  return Object.freeze({
    environment: Object.freeze({
      ...(provider === "codex" ? { CODEX_HOME: providerConfig } : { CLAUDE_CONFIG_DIR: providerConfig }),
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: temporary,
    }),
    privateRootPath,
  });
};

type CustodyOptions = Omit<ConstructorParameters<typeof NodeProviderProcessCustody>[0], "launchPlans">;

export const launchPlan = async (input: {
  readonly binding?: typeof binding | typeof claudeBinding;
  readonly executablePath?: string;
  readonly script?: string;
  readonly searchPath?: string;
  readonly spawnMode?: "eager" | "sdk-delegated";
  readonly workspaceRef: string;
}) => {
  const providerBinding = input.binding ?? binding;
  const executablePath = await realpath(input.executablePath ?? process.execPath);
  const launchArguments = Object.freeze(["-e", input.script ?? fixtureScript]);
  const privatePaths = await privatePathsFor(input.workspaceRef, providerBinding.provider);
  return Object.freeze({
    plan: Object.freeze({
      arguments: launchArguments,
      binaryRevision: providerBinding.binaryRevision,
      containmentProfile: "strict-linux-cgroup-v2" as const,
      environment: Object.freeze({
        ...privatePaths.environment,
        ...(input.searchPath === undefined ? {} : { PATH: input.searchPath }),
      }),
      executablePath,
      executableSha256: await executableDigest(executablePath),
      intentMode: "analysis" as const,
      privatePathEnvironmentKeys: Object.freeze(providerBinding.provider === "codex"
        ? ["CODEX_HOME", "HOME", "TMPDIR"]
        : ["CLAUDE_CONFIG_DIR", "HOME", "TMPDIR"]),
      privateRootPath: privatePaths.privateRootPath,
      provider: providerBinding.provider,
      spawnMode: input.spawnMode,
    }),
    providerBinding,
  });
};

export const createCustody = async (input: {
  readonly binding?: typeof binding | typeof claudeBinding;
  readonly options?: CustodyOptions;
  readonly qualifiedIdentity?: boolean;
  readonly script?: string;
  readonly searchPath?: string;
  readonly spawnMode?: "eager" | "sdk-delegated";
  readonly workspaceRef: string;
}) => {
  const entry = await launchPlan(input);
  const custody = new NodeProviderProcessCustody({
    drainAfterMs: 500,
    forceKillAfterMs: 500,
    hostLifecycleGeneration: "synthetic-host-generation",
    maxDiagnosticBytes: 4_096,
    residueAuthorityFactory: syntheticResidueAuthorityFactory,
    spawnAcknowledgementAfterMs: 60_000,
    identityObservationAfterMs: 60_000,
    ...(input.qualifiedIdentity === false
      ? { processIdentityObserver: {async observe() {return { status: "unproven" as const };}} }
      : { processIdentityObserver: qualifiedIdentityObserver }),
    terminateAfterMs: 500,
    ...input.options,
    launchPlans: createStaticHostCustodyLaunchPlanResolver([entry]),
  });
  return {
    arguments: entry.plan.arguments,
    custody,
    environment: entry.plan.environment,
    executablePath: entry.plan.executablePath,
  };
};

export const collect = async (source: AsyncIterable<Uint8Array>, pauseMs = 0): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const bytes of source) {
    chunks.push(Buffer.from(bytes));
    if (pauseMs > 0) {await new Promise(resolve => {setTimeout(resolve, pauseMs);});}
  }
  return Buffer.concat(chunks);
};

export const nextText = async (source: AsyncIterable<Uint8Array>): Promise<string> => {
  const next = await source[Symbol.asyncIterator]().next();
  if (next.done) {throw new Error("Host Custody test stream ended before yielding output");}
  return Buffer.from(next.value).toString("utf8");
};

export const waitForProvedIdentity = async (
  custody: NodeProviderProcessCustody,
  custodyRef: string,
): Promise<void> => {
  const deadline = performance.now() + 15_000;
  while (custody.evidence(custodyRef)?.identity.status !== "proved") {
    if (performance.now() >= deadline) {throw new Error("Host Custody identity proof did not settle");}
    await new Promise(resolve => {setTimeout(resolve, 10);});
  }
};

export const waitForEvidence = async (
  custody: NodeProviderProcessCustody,
  custodyRef: string,
  predicate: (evidence: NonNullable<ReturnType<NodeProviderProcessCustody["evidence"]>>) => boolean,
): Promise<void> => {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const evidence = custody.evidence(custodyRef);
    if (evidence !== undefined && predicate(evidence)) {return;}
    if (performance.now() >= deadline) {throw new Error("Host Custody evidence did not reach the expected state");}
    await new Promise(resolve => {setTimeout(resolve, 10);});
  }
};
