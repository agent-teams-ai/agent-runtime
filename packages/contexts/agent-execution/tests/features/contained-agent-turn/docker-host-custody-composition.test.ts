import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDockerHostCustodyLifecycle,
  type DockerHostCustodyContainerCreate,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-host-custody-lifecycle.js";
import { FakeDockerEngine } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import type { DockerEngineCall, DockerEnginePolicy } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import {
  bindDockerCustodyAttemptKey,
  DOCKER_CUSTODY_STATES,
  DockerCustodyJournal,
  DockerCustodyJournalConflictError,
  dockerCustodyAttemptLocator,
  dockerCustodyAuthoritySha256,
  dockerCustodyOwnerIdentitySha256,
  type DockerCustodyAttemptKey,
  type DockerCustodyJournalFile,
  type DockerCustodyOwnerIdentity,
  type DockerCustodyJournalStorage,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/journal/index.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const FINGERPRINT = digest("launch");
const NONCE = digest("operation");
const IMAGE = `registry.invalid/runtime@sha256:${digest("image")}`;
const SECCOMP_JSON = JSON.stringify({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [] });

class MemoryFile implements DockerCustodyJournalFile {
  public bytes = Buffer.alloc(0);
  public get byteLength(): number {return this.bytes.byteLength;}
  public async append(expectedByteLength: number, bytes: Uint8Array): Promise<void> {
    if (this.byteLength !== expectedByteLength) {throw new DockerCustodyJournalConflictError();}
    this.bytes = Buffer.concat([this.bytes, bytes]);
  }
  public async close(): Promise<void> {}
  public async read(maxBytes: number): Promise<Uint8Array> {
    if (this.byteLength > maxBytes) {throw new Error("bounded journal read exceeded");}
    return this.bytes;
  }
}

class MemoryStorage implements DockerCustodyJournalStorage {
  public readonly files = new Map<string, MemoryFile>();
  public readonly retirements = new Map<string, MemoryFile>();
  private serial = Promise.resolve();
  public async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>(resolve => {release = resolve;});
    await previous;
    try {return await operation();} finally {release();}
  }
  public async create(locator: string): Promise<DockerCustodyJournalFile> {
    if (this.files.has(locator)) {throw new DockerCustodyJournalConflictError();}
    const file = new MemoryFile();
    this.files.set(locator, file);
    return file;
  }
  public async open(locator: string): Promise<DockerCustodyJournalFile | undefined> {
    return this.files.get(locator);
  }
  public async openRetirement(locator: string): Promise<DockerCustodyJournalFile | undefined> {
    return this.retirements.get(locator);
  }
  public async retire(locator: string, receipt: Uint8Array): Promise<void> {
    const existing = this.retirements.get(locator);
    if (existing !== undefined && !existing.bytes.equals(Buffer.from(receipt))) {
      throw new DockerCustodyJournalConflictError();
    }
    if (existing === undefined) {
      const durable = new MemoryFile();
      await durable.append(0, receipt);
      this.retirements.set(locator, durable);
    }
    if (!this.files.delete(locator)) {throw new DockerCustodyJournalConflictError();}
  }
  public async scan(maxFiles: number) {
    if (this.files.size > maxFiles) {throw new Error("bounded journal scan exceeded");}
    return [...this.files].map(([locatorSha256, file]) => ({ file, locatorSha256 }));
  }
}

const engineCall = (): DockerEngineCall => ({
  deadlineEpochMs: Date.now() + 5_000,
  signal: new AbortController().signal,
});

const policy = (root: string): DockerEnginePolicy => ({
  allowedEnvironmentKeys: ["AR_OPERATION"],
  allowedNetworkName: "ar-operation-gateway",
  appArmorProfile: "agent-runtime-contained-turn-v1",
  cgroupParent: "system.slice/agent-runtime.slice",
  cpuNanoCpus: 500_000_000,
  daemonPidFileMode: 0o600,
  daemonPidFileOwnerGid: process.getgid?.() ?? 0,
  daemonPidFileOwnerUid: process.getuid?.() ?? 0,
  daemonPidFilePath: join(root, "docker.pid"),
  hostIdentitySha256: digest("host"),
  memoryBytes: 100_663_296,
  pidsLimit: 32,
  privateRootSourceRoot: join(root, "private"),
  seccompProfileJson: SECCOMP_JSON,
  seccompProfileSha256: digest(SECCOMP_JSON),
  socketMode: 0o600,
  socketOwnerGid: process.getgid?.() ?? 0,
  socketOwnerUid: process.getuid?.() ?? 0,
  socketPath: join(root, "docker.sock"),
  tmpfsBytes: 16_777_216,
  user: "65532:65532",
  workspaceSourceRoot: join(root, "workspaces"),
  writableLayerBytes: 33_554_432,
});

const createInput = (root: string, nonce = NONCE): DockerHostCustodyContainerCreate => ({
  arguments: ["serve", "--stdio"],
  entrypoint: "/usr/local/bin/provider",
  environment: { AR_OPERATION: "opaque-operation" },
  imageDigest: IMAGE,
  launchFingerprintSha256: FINGERPRINT,
  operationNonceSha256: nonce,
  privateRootSource: join(root, "private", "operation"),
  workspaceSource: join(root, "workspaces", "operation"),
  workspaceWritable: true,
});

const owner = Object.freeze({
  attemptId: "attempt:docker-composition",
  custodyId: "custody:docker-composition",
  hostBootId: "host-boot:docker-composition",
  hostInstanceId: "host-instance:docker-composition",
  operationId: "operation:docker-composition",
  projectId: "project:docker-composition",
  tenantId: "tenant:docker-composition",
}) satisfies DockerCustodyOwnerIdentity;

const disposable = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ar-docker-custody-composition-"));
  await Promise.all([
    mkdir(join(root, "private", "operation"), { recursive: true }),
    mkdir(join(root, "workspaces", "operation"), { recursive: true }),
  ]);
  return root;
};

test("Host Custody composition journals effects, actively recovers containment, and retires capacity", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const journal = new DockerCustodyJournal(storage, { maxJournalFiles: 1 });
  const engine = new FakeDockerEngine(policy(root));
  const residue = Object.freeze({async proveEmpty() {return "empty" as const;}});
  const lifecycle = createDockerHostCustodyLifecycle({
    engine,
    journalLimits: { maxJournalFiles: 1 },
    journalStorage: storage,
    residue,
  });
  const create = createInput(root);
  const call = engineCall();
  const launched = await lifecycle.launch({ call, create, owner });
  await lifecycle.executeProvider({
    authority: launched.authority,
    call: engineCall(),
    async execute() {return "proved";},
    key: launched.key,
  });

  const resolver = Object.freeze({async resolve(key: DockerCustodyAttemptKey) {
    return key.attemptId === owner.attemptId
      ? { authority: launched.authority, call: engineCall(), create }
      : undefined;
  }});
  const recovered = await createDockerHostCustodyLifecycle({
    engine,
    journalLimits: { maxJournalFiles: 1 },
    journalStorage: storage,
    residue,
  }).recover(resolver);
  assert.equal(recovered[0]?.kind, "closed");
  assert.equal(recovered[0]?.kind === "closed" && recovered[0].journal.state, "closed");
  assert.equal((await engine.inspect(launched.authority, engineCall())).existence, "absent");
  assert.equal((await lifecycle.recover(resolver))[0]?.kind, "closed");
  const closed = recovered[0];
  assert.equal(closed?.kind, "closed");
  if (closed?.kind !== "closed") {throw new Error("expected recovered close");}
  await lifecycle.retire({ expectedChecksumSha256: closed.journal.checksumSha256, key: launched.key });
  assert.equal(storage.files.size, 0);

  await journal.prepare({ ...launched.key, attemptId: "attempt:later", custodyId: "custody:later" });
  assert.equal(storage.files.size, 1);
});

test("unproved Docker residue remains indeterminate across repeated recovery and cannot retire", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const lifecycle = createDockerHostCustodyLifecycle({
    engine,
    journalStorage: storage,
    residue: Object.freeze({async proveEmpty() {return "unknown" as const;}}),
  });
  const create = createInput(root);
  const launched = await lifecycle.launch({ call: engineCall(), create, owner });
  await lifecycle.executeProvider({
    authority: launched.authority, call: engineCall(), async execute() {return "proved";}, key: launched.key,
  });
  const containment = await lifecycle.contain({ authority: launched.authority, call: engineCall(), key: launched.key });
  assert.equal(containment.kind, "indeterminate");
  assert.equal("journal" in containment && containment.journal.evidence.status, "unproven");
  if (!("journal" in containment)) {throw new Error("expected a durable unproven journal");}

  const resolver = Object.freeze({async resolve() {
    return { authority: launched.authority, call: engineCall(), create };
  }});
  for (let recovery = 0; recovery < 2; recovery += 1) {
    const observed = await lifecycle.recover(resolver);
    assert.equal(observed[0]?.kind, "indeterminate");
    assert.equal(observed[0]?.kind === "indeterminate" && observed[0].reason, "containment_unproven");
  }
  await assert.rejects(lifecycle.retire({
    expectedChecksumSha256: containment.journal.checksumSha256,
    key: launched.key,
  }), { name: "DockerCustodyJournalConflictError" });
  assert.equal(storage.files.size, 1);
});

test("a missing post-launch journal remains ambiguous while exact owner authority contains the live resource", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const lifecycle = createDockerHostCustodyLifecycle({
    engine,
    journalStorage: storage,
    residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create: createInput(root), owner });
  assert.equal(storage.files.delete(dockerCustodyAttemptLocator(launched.key)), true);

  const containment = await lifecycle.contain({
    authority: launched.authority,
    call: engineCall(),
    key: launched.key,
  });
  assert.deepEqual(containment, {
    authority: launched.authority,
    containment: "closed",
    kind: "indeterminate",
    reason: "journal_unavailable",
  });
  assert.equal((await engine.inspect(launched.authority, engineCall())).existence, "absent");
  assert.equal(storage.files.size, 0);
});

test("journal loss after lifecycle restart leaves no authority to guess and performs zero mutation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const residue = Object.freeze({async proveEmpty() {return "empty" as const;}});
  const launched = await createDockerHostCustodyLifecycle({ engine, journalStorage: storage, residue }).launch({
    call: engineCall(), create: createInput(root), owner,
  });
  assert.equal(storage.files.delete(dockerCustodyAttemptLocator(launched.key)), true);
  const restarted = createDockerHostCustodyLifecycle({ engine, journalStorage: storage, residue });
  const mutationStart = engine.events.length;

  const containment = await restarted.contain({
    authority: launched.authority, call: engineCall(), key: launched.key,
  });
  assert.deepEqual(containment, {
    authority: launched.authority,
    containment: "indeterminate",
    kind: "indeterminate",
    reason: "authority_unavailable",
  });
  assert.deepEqual(engine.events.slice(mutationStart).filter(event => /^(?:stop|kill|remove):/u.test(event)), []);
  assert.equal((await engine.inspect(launched.authority, engineCall())).existence, "present");
});

test("recovery refuses a foreign replacement with copied owner labels before stop or remove", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const create = createInput(root);
  const lifecycle = createDockerHostCustodyLifecycle({
    engine,
    journalStorage: storage,
    residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create, owner });
  await engine.stop(launched.authority, engineCall());
  await engine.remove(launched.authority, engineCall());
  const foreignCreate = {
    ...create,
    arguments: ["foreign", "--replacement"],
    imageDigest: `registry.invalid/foreign@sha256:${digest("foreign-image")}`,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(launched.key),
  };
  const foreign = await engine.create(foreignCreate, engineCall());
  await engine.attachCustody(foreign, engineCall());
  await engine.start(foreign, engineCall());
  const recoveryEventStart = engine.events.length;

  const recovered = await lifecycle.recover(Object.freeze({async resolve() {
    return { authority: foreign, call: engineCall(), create };
  }}));
  assert.equal(recovered[0]?.kind, "indeterminate");
  assert.equal(recovered[0]?.kind === "indeterminate" && recovered[0].reason, "engine_observation_unavailable");
  assert.deepEqual(
    engine.events.slice(recoveryEventStart).filter(event => event === "stop:id" || event === "remove:id"),
    [],
  );
  assert.equal((await engine.inspect(foreign, engineCall())).existence, "present");
});

test("direct containment refuses a foreign replacement with copied owner labels before stop, kill, or remove", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const create = createInput(root);
  const lifecycle = createDockerHostCustodyLifecycle({
    engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create, owner });
  await engine.stop(launched.authority, engineCall());
  await engine.remove(launched.authority, engineCall());
  const foreign = await engine.create({
    ...create,
    arguments: ["foreign", "--replacement"],
    imageDigest: `registry.invalid/foreign@sha256:${digest("foreign-image")}`,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(launched.key),
  }, engineCall());
  await engine.attachCustody(foreign, engineCall());
  await engine.start(foreign, engineCall());
  const mutationStart = engine.events.length;

  const containment = await lifecycle.contain({ authority: foreign, call: engineCall(), key: launched.key });
  assert.deepEqual(containment, {
    authority: foreign, containment: "indeterminate", kind: "indeterminate", reason: "authority_mismatch",
  });
  assert.deepEqual(engine.events.slice(mutationStart).filter(event => /^(?:stop|kill|remove):/u.test(event)), []);
  assert.equal((await engine.inspect(foreign, engineCall())).existence, "present");
});

test("missing-journal containment uses only its held exact authority and refuses a foreign replacement", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const create = createInput(root);
  const lifecycle = createDockerHostCustodyLifecycle({
    engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create, owner });
  await engine.stop(launched.authority, engineCall());
  await engine.remove(launched.authority, engineCall());
  const foreign = await engine.create({
    ...create,
    arguments: ["foreign", "--replacement"],
    imageDigest: `registry.invalid/foreign@sha256:${digest("foreign-image")}`,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(launched.key),
  }, engineCall());
  await engine.attachCustody(foreign, engineCall());
  await engine.start(foreign, engineCall());
  assert.equal(storage.files.delete(dockerCustodyAttemptLocator(launched.key)), true);
  const mutationStart = engine.events.length;

  const containment = await lifecycle.contain({ authority: foreign, call: engineCall(), key: launched.key });
  assert.deepEqual(containment, {
    authority: foreign, containment: "indeterminate", kind: "indeterminate", reason: "authority_mismatch",
  });
  assert.deepEqual(engine.events.slice(mutationStart).filter(event => /^(?:stop|kill|remove):/u.test(event)), []);
  assert.equal((await engine.inspect(foreign, engineCall())).existence, "present");
});

const bindAttempt = async (
  engine: FakeDockerEngine,
  create: DockerHostCustodyContainerCreate,
  ownerIdentity: DockerCustodyOwnerIdentity = owner,
): Promise<DockerCustodyAttemptKey> => {
  const identity = await engine.identity(engineCall());
  return bindDockerCustodyAttemptKey({
    daemonBootGenerationSha256: identity.daemonBootGenerationSha256,
    daemonIdentitySha256: identity.daemonIdentitySha256,
    hostBootGenerationSha256: identity.hostBootGenerationSha256,
    hostIdentitySha256: identity.hostIdentitySha256,
    launchFingerprintSha256: create.launchFingerprintSha256,
    operationNonceSha256: create.operationNonceSha256,
    owner: ownerIdentity,
  });
};

test("cancellation immediately after init_ready contains without requesting provider execution", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const lifecycle = createDockerHostCustodyLifecycle({
    engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create: createInput(root), owner });
  assert.equal(launched.journal.sequence, 4);
  const closed = await Promise.all([
    lifecycle.contain({ authority: launched.authority, call: engineCall(), key: launched.key }),
    lifecycle.contain({ authority: launched.authority, call: engineCall(), key: launched.key }),
  ]);
  assert.equal(closed.every(result => result.kind === "closed" && result.journal.state === "closed"), true);
  assert.equal((await new DockerCustodyJournal(storage).recover())[0]?.providerExecution, "not_requested");
  assert.equal((await engine.inspect(launched.authority, engineCall())).existence, "absent");
});

test("resolved cleanup debt retries idempotently and can retire", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  let residueChecks = 0;
  const lifecycle = createDockerHostCustodyLifecycle({
    engine,
    journalStorage: storage,
    residue: Object.freeze({async proveEmpty() {
      residueChecks += 1;
      return residueChecks === 1 ? "unknown" as const : "empty" as const;
    }}),
  });
  const launched = await lifecycle.launch({ call: engineCall(), create: createInput(root), owner });
  assert.equal((await lifecycle.contain({
    authority: launched.authority, call: engineCall(), key: launched.key,
  })).kind, "indeterminate");
  const closed = await lifecycle.contain({ authority: launched.authority, call: engineCall(), key: launched.key });
  assert.equal(closed.kind, "closed");
  assert.equal(residueChecks, 2);
  await lifecycle.retire({ expectedChecksumSha256: closed.journal.checksumSha256, key: launched.key });
  assert.equal(storage.files.size, 0);
});

test("every canonical owner, nonce, fingerprint, and engine-generation mismatch rejects before mutation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const baseCreate = createInput(root);
  const ownerMismatches: readonly Partial<DockerCustodyOwnerIdentity>[] = [
    { tenantId: "tenant:mismatch" },
    { projectId: "project:mismatch" },
    { operationId: "operation:mismatch" },
    { attemptId: "attempt:mismatch" },
    { custodyId: "custody:mismatch" },
    { hostInstanceId: "host-instance:mismatch" },
    { hostBootId: "host-boot:mismatch" },
  ];
  const launchMismatches: readonly Readonly<{
    create: DockerHostCustodyContainerCreate;
    owner: DockerCustodyOwnerIdentity;
  }>[] = [
    ...ownerMismatches.map(changed => ({ create: baseCreate, owner: { ...owner, ...changed } })),
    { create: { ...baseCreate, launchFingerprintSha256: digest("mismatched-fingerprint") }, owner },
    { create: { ...baseCreate, operationNonceSha256: digest("mismatched-nonce") }, owner },
  ];
  for (const mismatch of launchMismatches) {
    const storage = new MemoryStorage();
    const engine = new FakeDockerEngine(policy(root));
    await new DockerCustodyJournal(storage).prepare(await bindAttempt(engine, baseCreate));
    const lifecycle = createDockerHostCustodyLifecycle({
      engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
    });
    await assert.rejects(lifecycle.launch({ call: engineCall(), ...mismatch }), {
      name: "DockerCustodyJournalConflictError",
    });
    assert.deepEqual(engine.events.filter(event => event.startsWith("create:") || event === "start:id"), []);
  }
  for (const generation of ["daemon", "host"] as const) {
    const storage = new MemoryStorage();
    const engine = new FakeDockerEngine(policy(root));
    await new DockerCustodyJournal(storage).prepare(await bindAttempt(engine, baseCreate));
    if (generation === "daemon") {engine.restartDaemon("changed");} else {engine.restartHost("changed");}
    const lifecycle = createDockerHostCustodyLifecycle({
      engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
    });
    await assert.rejects(lifecycle.launch({ call: engineCall(), create: baseCreate, owner }), {
      name: "DockerCustodyJournalConflictError",
    });
    assert.deepEqual(engine.events.filter(event => event.startsWith("create:") || event === "start:id"), []);
  }
});

test("recovery closes every accepted live state and every external-action crash boundary without provider retry", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const targetState of DOCKER_CUSTODY_STATES) {
    const storage = new MemoryStorage();
    const engine = new FakeDockerEngine(policy(root));
    const create = createInput(root, digest(`recovery-state:${targetState}`));
    const key = await bindAttempt(engine, create);
    const journal = new DockerCustodyJournal(storage);
    let record = await journal.prepare(key);
    let authority: Awaited<ReturnType<FakeDockerEngine["create"]>> | undefined;
    const targetIndex = DOCKER_CUSTODY_STATES.indexOf(targetState);
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("create_requested")) {
      record = await journal.beforeAction({ key, expectedSequence: record.sequence, state: "create_requested" });
      authority = await engine.create({
        ...create,
        ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(key),
      }, engineCall());
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("created")) {
      assert.ok(authority);
      record = await journal.observe({
        authoritySha256: dockerCustodyAuthoritySha256(authority),
        key, expectedSequence: record.sequence, state: "created", evidence: { status: "proved" },
      });
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("init_start_requested")) {
      record = await journal.beforeAction({ key, expectedSequence: record.sequence, state: "init_start_requested" });
      assert.ok(authority);
      await engine.attachCustody(authority, engineCall());
      await engine.start(authority, engineCall());
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("init_ready")) {
      record = await journal.observe({ key, expectedSequence: record.sequence, state: "init_ready", evidence: { status: "proved" } });
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("provider_exec_requested")) {
      record = await journal.beforeAction({ key, expectedSequence: record.sequence, state: "provider_exec_requested" });
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("provider_exec_observed")) {
      record = await journal.observe({
        key, expectedSequence: record.sequence, state: "provider_exec_observed", evidence: { status: "proved" },
      });
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("contain_requested")) {
      record = await journal.beforeAction({ key, expectedSequence: record.sequence, state: "contain_requested" });
      assert.ok(authority);
      await engine.stop(authority, engineCall());
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("empty_observed")) {
      record = await journal.observe({ key, expectedSequence: record.sequence, state: "empty_observed", evidence: { status: "proved" } });
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("remove_requested")) {
      record = await journal.beforeAction({ key, expectedSequence: record.sequence, state: "remove_requested" });
      assert.ok(authority);
      await engine.remove(authority, engineCall());
    }
    if (targetIndex >= DOCKER_CUSTODY_STATES.indexOf("removed_observed")) {
      record = await journal.observe({
        key, expectedSequence: record.sequence, state: "removed_observed", evidence: { status: "proved" },
      });
    }
    if (targetState === "closed") {
      record = await journal.observe({ key, expectedSequence: record.sequence, state: "closed", evidence: { status: "proved" } });
    }
    assert.equal(record.state, targetState);
    const lifecycle = createDockerHostCustodyLifecycle({
      engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
    });
    const recovered = await lifecycle.recover(Object.freeze({async resolve() {
      return authority === undefined ? undefined : { authority, call: engineCall(), create };
    }}));
    assert.equal(recovered[0]?.kind, "closed", targetState);
    if (authority !== undefined) {
      assert.equal((await engine.inspect(authority, engineCall())).existence, "absent", targetState);
    }
    if (targetState === "provider_exec_requested") {
      await assert.rejects(lifecycle.retire({
        expectedChecksumSha256: recovered[0]?.kind === "closed" ? recovered[0].journal.checksumSha256 : "",
        key,
      }), { name: "DockerCustodyJournalConflictError" });
    }
  }
});

test("partial-tail recovery still contains exact owned residue while preserving journal ambiguity", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const storage = new MemoryStorage();
  const engine = new FakeDockerEngine(policy(root));
  const create = createInput(root, digest("partial-tail"));
  const key = await bindAttempt(engine, create);
  const journal = new DockerCustodyJournal(storage);
  await journal.prepare(key);
  await journal.beforeAction({ key, expectedSequence: 0, state: "create_requested" });
  const authority = await engine.create({
    ...create,
    ownerIdentitySha256: dockerCustodyOwnerIdentitySha256(key),
  }, engineCall());
  const file = storage.files.values().next().value as MemoryFile | undefined;
  assert.ok(file);
  file.bytes = Buffer.concat([file.bytes, Buffer.from('{"partial":')]);
  const before = Buffer.from(file.bytes);
  const lifecycle = createDockerHostCustodyLifecycle({
    engine, journalStorage: storage, residue: Object.freeze({async proveEmpty() {return "empty" as const;}}),
  });
  const recovered = await lifecycle.recover(Object.freeze({async resolve() {
    return { authority, call: engineCall(), create };
  }}));
  assert.equal(recovered[0]?.kind, "journal_unproven");
  assert.equal(recovered[0]?.kind === "journal_unproven" && recovered[0].containment, "closed");
  assert.equal((await engine.inspect(authority, engineCall())).existence, "absent");
  assert.deepEqual(file.bytes, before);
  assert.equal(file.bytes.includes(Buffer.from(root)), false);
  assert.equal(file.bytes.includes(Buffer.from("opaque-operation")), false);
});
