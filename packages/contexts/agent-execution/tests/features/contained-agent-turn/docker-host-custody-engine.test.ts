import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  DockerEngineError,
  FakeDockerEngine,
  NodeUnixSocketDockerEngine,
} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { snapshotDockerEngineCall } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/docker-boundary-snapshot.js";
import type { DockerLogFrame } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/index.js";
import { createSpecificationMutations } from "../../fixtures/docker-create-specification-mutations.ts";
import {
  CONTAINER,
  DAEMON_BOOT,
  HOST_BOOT,
  NONCE,
  call,
  createInput,
  disposable,
  policy,
} from "../../fixtures/docker-engine-test-fixture.ts";
import {
  drain,
  jsonResponse,
} from "./docker-engine-transport-test-fixture.ts";

import { syntheticDaemon } from "../../fixtures/docker-engine-synthetic-daemon.ts";

test("Node adapter emits the closed schema and completes lifecycle only by exact observations", async t => {
  const root = await disposable();
  const daemon = syntheticDaemon();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.equal(authority.daemonBootGenerationSha256, DAEMON_BOOT);
  const body = daemon.bodies[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).toSorted(), [
    "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "HostConfig", "Image",
    "Labels", "NetworkDisabled", "OpenStdin", "StdinOnce", "StopSignal", "Tty", "User", "WorkingDir",
  ]);
  assert.equal(body.AttachStdin, false);
  assert.equal(body.OpenStdin, true);
  assert.equal(body.StdinOnce, true);
  assert.equal(body.Tty, false);
  const custody = await engine.attachCustody(authority, call());
  await custody.write(Buffer.from("init-control"));
  await engine.start(authority, call());
  const frames: DockerLogFrame[] = [];
  for await (const frame of engine.logs(authority, call())) {frames.push(frame);}
  assert.deepEqual(frames.map(frame => [frame.stream, Buffer.from(frame.bytes).toString()]), [
    ["stdout", "out"], ["stderr", "err"],
  ]);
  const terminal = await engine.wait(authority, call());
  assert.equal(terminal.existence, "present");
  await engine.remove(authority, call());
  assert.equal((await engine.inspect(authority, call())).existence, "absent");
  assert.ok(daemon.routes.filter(route => /(?:start|stop|kill|wait|force=)/u.test(route))
    .every(route => route.includes(CONTAINER)));
});

test("API v1.47 fixture accepts evidenced OOM null with the synthetic owner-binding projection", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const fixtureUrl = new URL("../../fixtures/docker-engine-api-v1.47-engine-29.6.1-redacted.json", import.meta.url);
  const fixtureSource = (await readFile(fixtureUrl, "utf8"))
    .replaceAll("__WORKSPACE_SOURCE__", join(root, "workspaces", "operation"))
    .replaceAll("__PRIVATE_SOURCE__", join(root, "private", "operation"));
  const fixture = JSON.parse(fixtureSource) as {
    readonly info: unknown;
    readonly inspect: { readonly HostConfig: { OomKillDisable: unknown }; readonly Config: { readonly Labels: Record<string, string>; OpenStdin: boolean; StdinOnce: boolean } };
  };
  // This corrected diagnostic fixture is not a fresh capture. Project the current
  // owner/stdin contract only in this synthetic test.
  fixture.inspect.Config.Labels["com.agent-runtime.owner-identity-sha256"] = createInput(root).ownerIdentitySha256;
  fixture.inspect.Config.OpenStdin = true;
  fixture.inspect.Config.StdinOnce = true;
  let present = false;
  const client = {
    async buffered(request: { readonly method: string; readonly path: string }) {
      if (request.path === "/v1.47/info") {return jsonResponse(200, fixture.info);}
      if (request.method === "POST" && request.path.startsWith("/v1.47/containers/create?name=")) {
        present = true;
        return jsonResponse(201, { Id: CONTAINER, Warnings: [] });
      }
      if (request.method === "GET" && request.path.endsWith("/json") && present) {
        return jsonResponse(200, fixture.inspect);
      }
      return jsonResponse(404, { message: "not found" });
    },
    async endpointIdentity() {
      return {
        canonicalSocketPath: "/policy/docker.sock",
        daemonBootGenerationSha256: DAEMON_BOOT,
        hostBootGenerationSha256: HOST_BOOT,
      };
    },
    async stream() {throw new DockerEngineError("protocol-violation");},
  };
  const engine = new NodeUnixSocketDockerEngine({ client, policy: policy(root) });
  assert.equal(fixture.inspect.HostConfig.OomKillDisable, null);
  const authority = await engine.create(createInput(root), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.equal((await engine.inspect(authority, call())).existence, "present");
  fixture.inspect.HostConfig.OomKillDisable = false;
  assert.equal((await engine.inspect(authority, call())).existence, "present");
});

test("create environment keys use locale-independent byte ordering", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const orderedPolicy = { ...policy(root), allowedEnvironmentKeys: ["Z_KEY", "_A_KEY"] };
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: orderedPolicy });
  await engine.create({
    ...createInput(root),
    environment: { _A_KEY: "second", Z_KEY: "first" },
  }, call());
  const request = daemon.bodies[0] as { readonly Env: readonly string[] };
  assert.deepEqual(request.Env.slice(-2), ["Z_KEY=first", "_A_KEY=second"]);
});

test("strict JSON and closed decoders reject duplicate keys, unknown fields, and primitive coercion", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  for (const mutate of [
    (daemon: SyntheticDaemon) => {daemon.extraInfoField = true;},
    (daemon: SyntheticDaemon) => {daemon.infoCgroupVersion = 2;},
  ]) {
    const daemon = syntheticDaemon();
    mutate(daemon);
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(createInput(root, createHash("sha256").update(String(Math.random())).digest("hex")), call()), {
      code: "malformed-response",
    });
  }
  const duplicate = syntheticDaemon();
  duplicate.rawCreateBody = Buffer.from(`{"Id":"${CONTAINER}","Id":"${CONTAINER}","Warnings":[]}`);
  const duplicateEngine = new NodeUnixSocketDockerEngine({ client: duplicate.client, policy: policy(root) });
  const reconciled = await duplicateEngine.create(createInput(root, "8".repeat(64)), call());
  assert.equal(reconciled.containerId, CONTAINER);
  assert.ok(duplicate.routes.includes(`GET /v1.47/containers/ar-turn-${"8".repeat(64)}/json`));
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.mutationPlan = {
    body: { Unexpected: true, message: "synthetic rejection" },
    effect: false,
    statusCode: 409,
  };
  await assert.rejects(engine.remove(authority, call()), { code: "malformed-response" });
  daemon.inspectTransform = value => {
    const config = value.Config as Record<string, unknown>;
    config.Unexpected = true;
  };
  await assert.rejects(engine.inspect(authority, call()), { code: "malformed-response" });
});

test("public boundaries reject proxies, inherited fields, and accessors before deriving a request path", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  const routeCount = daemon.routes.length;
  await assert.rejects(engine.start(new Proxy(authority, {}), call()), { code: "invalid-authority" });
  assert.equal(daemon.routes.length, routeCount);

  const accessor = { ...authority } as Record<string, unknown>;
  Object.defineProperty(accessor, "containerId", {
    enumerable: true,
    get() {throw new Error("secret accessor diagnostic");},
  });
  await assert.rejects(engine.kill(accessor as unknown as typeof authority, call()), error =>
    error instanceof DockerEngineError && error.code === "invalid-authority" &&
    !error.message.includes("secret accessor diagnostic"));
  assert.equal(daemon.routes.length, routeCount);

  const inherited = Object.create(authority) as typeof authority;
  await assert.rejects(engine.remove(inherited, call()), { code: "invalid-authority" });
  assert.equal(daemon.routes.length, routeCount);

  const hostilePolicy = { ...policy(root) };
  Object.defineProperty(hostilePolicy, "socketPath", {
    enumerable: true,
    get() {throw new Error("secret policy accessor diagnostic");},
  });
  assert.throws(() => new NodeUnixSocketDockerEngine({ client: daemon.client, policy: hostilePolicy }), error =>
    error instanceof DockerEngineError && error.code === "invalid-create-request" &&
    !error.message.includes("secret policy accessor diagnostic"));
});

test("engine call snapshots preserve native AbortSignal state across later expandos and cancellation", () => {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "addEventListener", {
    configurable: true,
    value() {throw new Error("shadowed signal listener");},
  });
  const snapshot = snapshotDockerEngineCall({ deadlineEpochMs: Date.now() + 10_000, signal: controller.signal });
  Object.defineProperty(controller.signal, "aborted", { configurable: true, value: true, writable: true });
  assert.equal(snapshot.signal.aborted, false);
  Object.defineProperty(controller.signal, "aborted", { configurable: true, value: false, writable: true });
  controller.abort();
  assert.equal(snapshot.signal.aborted, true);
  assert.equal(Object.isExtensible(snapshot.signal), false);
  assert.throws(() => Object.defineProperty(snapshot.signal, "aborted", { value: false }), TypeError);
});

test("lost create reconciliation refuses every policy-adjacent foreign specification", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const transforms = createSpecificationMutations(root);
  await mkdir(join(root, "workspaces", "foreign"));
  await mkdir(join(root, "private", "foreign"));
  for (const [index, transform] of transforms.entries()) {
    const daemon = syntheticDaemon();
    daemon.loseNextCreate = true;
    daemon.inspectTransform = transform;
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(createInput(root, createHash("sha256").update(`foreign-${index}`).digest("hex")), call()), {
      code: "create-acknowledgement-unknown",
    });
  }
});

test("an oversized create response reconciles a create that may already be committed", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  daemon.oversizeNextCreate = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root, "9".repeat(64)), call());
  assert.equal(authority.containerId, CONTAINER);
  assert.ok(daemon.routes.includes(`GET /v1.47/containers/ar-turn-${"9".repeat(64)}/json`));
});

test("persistent daemon identity is additionally fenced by daemon and host boot generations", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  daemon.daemonBoot = "3".repeat(64);
  await assert.rejects(engine.inspect(authority, call()), { code: "daemon-identity-changed" });
  const fake = new FakeDockerEngine(policy(root));
  const fakeAuthority = await fake.create(createInput(root), call());
  fake.restartDaemon("replacement");
  await assert.rejects(fake.inspect(fakeAuthority, call()), { code: "daemon-identity-changed" });
  const second = new FakeDockerEngine(policy(root));
  const hostAuthority = await second.create(createInput(root), call());
  second.restartHost("replacement");
  await assert.rejects(second.inspect(hostAuthority, call()), { code: "daemon-identity-changed" });
  const createFence = new FakeDockerEngine(policy(root));
  const expectedIdentity = await createFence.identity(call());
  createFence.restartDaemon("raced-before-create");
  await assert.rejects(createFence.create(createInput(root, "7".repeat(64)), call(), expectedIdentity), {
    code: "daemon-identity-changed",
  });
  assert.equal(createFence.events.some(event => event.startsWith("create:")), false);
});

test("ambiguous and 304 mutation acknowledgements require exact postconditions and 409 diagnostics are operation-specific", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  await engine.attachCustody(authority, call());
  daemon.mutationPlan = { body: { Unexpected: true }, effect: true, statusCode: 204 };
  await assert.rejects(engine.start(authority, call()), { code: "start-acknowledgement-unknown" });
  assert.ok(daemon.routes.filter(route => route === `GET /v1.47/containers/${CONTAINER}/json`).length >= 2);
  await assert.rejects(engine.start(authority, call()), { code: "protocol-violation" });
  const successful = syntheticDaemon();
  const successfulEngine = new NodeUnixSocketDockerEngine({client: successful.client, policy: policy(root)});
  const successfulAuthority = await successfulEngine.create(createInput(root, "9".repeat(64)), call());
  await successfulEngine.attachCustody(successfulAuthority, call());
  successful.mutationPlan = { effect: true, statusCode: 304 };
  await successfulEngine.start(successfulAuthority, call());
  successful.mutationPlan = { effect: false, statusCode: 304 };
  await assert.rejects(successfulEngine.stop(successfulAuthority, call()), { code: "mutation-acknowledgement-unknown" });
  successful.mutationPlan = { effect: true, failure: "disconnect", statusCode: 204 };
  await successfulEngine.stop(successfulAuthority, call());
  successful.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(successfulEngine.remove(successfulAuthority, call()), { code: "request-rejected", statusCode: 409 });
  const duplicate = syntheticDaemon();
  const duplicateEngine = new NodeUnixSocketDockerEngine({ client: duplicate.client, policy: policy(root) });
  await duplicateEngine.create(createInput(root), call());
  duplicate.mutationPlan = { effect: false, statusCode: 409 };
  await assert.rejects(duplicateEngine.create(createInput(root, "4".repeat(64)), call()), {
    code: "resource-already-exists",
    statusCode: 409,
  });
});

test("log EOF is incomplete while running and wait requires an exact terminal observation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const daemon = syntheticDaemon();
  daemon.logLeavesRunning = true;
  const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
  const authority = await engine.create(createInput(root), call());
  await engine.attachCustody(authority, call());
  await engine.start(authority, call());
  await assert.rejects(drain(engine.logs(authority, call())), { code: "terminal-observation-unknown" });
  await assert.rejects(engine.wait(authority, call()), { code: "terminal-observation-unknown" });
  await engine.stop(authority, call());
  assert.equal((await engine.wait(authority, call())).existence, "present");
});

test("inspection state decoding enforces bounded values, Docker timestamps, and the status truth table", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, { force: true, recursive: true });});
  const transforms: Array<(state: Record<string, unknown>) => void> = [
    state => {state.Pid = -1;},
    state => {state.ExitCode = 256;},
    state => {state.StartedAt = "not-a-docker-timestamp";},
    state => {state.FinishedAt = "2026-02-30T00:00:00Z";},
    state => {state.Status = "running"; state.Running = false;},
    state => {state.Status = "running"; state.Running = true; state.Pid = 0; state.StartedAt = "2026-01-01T00:00:00Z";},
    state => {state.Status = "paused"; state.Running = true; state.Paused = false; state.Pid = 42; state.StartedAt = "2026-01-01T00:00:00Z";},
    state => {state.Status = "exited"; state.Dead = false; state.Pid = 42; state.StartedAt = "2026-01-01T00:00:00Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
    state => {state.Status = "dead"; state.Dead = false; state.StartedAt = "2026-01-01T00:00:00Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
    state => {state.Status = "exited"; state.StartedAt = "2026-01-01T00:00:02Z"; state.FinishedAt = "2026-01-01T00:00:01Z";},
  ];
  for (const [index, transform] of transforms.entries()) {
    const daemon = syntheticDaemon();
    daemon.inspectTransform = value => {transform(value.State as Record<string, unknown>);};
    const engine = new NodeUnixSocketDockerEngine({ client: daemon.client, policy: policy(root) });
    await assert.rejects(engine.create(
      createInput(root, createHash("sha256").update(`state-${index}`).digest("hex")),
      call(),
    ), { code: "malformed-response" });
  }
});

test("Docker wire defaults preserve exact create authority and mount access", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  for (const workspaceWritable of [true, false]) {
    const daemon = syntheticDaemon();
    daemon.inspectTransform = value => {
      const config = value.Config as Record<string, unknown>;
      delete config.NetworkDisabled;
      const host = value.HostConfig as Record<string, unknown>;
      for (const mount of host.Mounts as Array<Record<string, unknown>>) {
        if (mount.ReadOnly === false) {delete mount.ReadOnly;}
      }
      // Informational inspect metadata, never a replacement for StorageOpt.
      value.Storage = {RootFS: {Snapshot: {Name: "redacted"}}};
    };
    const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
    const authority = await engine.create({...createInput(root), workspaceWritable}, call());
    const request = daemon.bodies[0] as {HostConfig: Record<string, unknown>};
    assert.equal(request.HostConfig.NanoCpus, policy(root).cpuNanoCpus);
    assert.equal(request.HostConfig.CpuPeriod, 0);
    assert.equal(request.HostConfig.PidMode, "");
    assert.equal(request.HostConfig.OomKillDisable, false);
    const observed = await engine.inspect(authority, call());
    assert.equal(observed.existence, "present");
    if (observed.existence === "present") {
      assert.equal(observed.resources.workspaceWritable, workspaceWritable);
      assert.equal(observed.resources.pidNamespaceMode, "private");
      assert.equal(observed.resources.cpuNanoCpus, policy(root).cpuNanoCpus);
    }
  }
});

test("wire compatibility rejects unrelated nulls, unsafe modes, and foreign resource authority", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const changes: Array<(value: Record<string, unknown>) => void> = [];
  for (const [key, values] of [
    ["CpuPeriod", [100_000, null, "0"]],
    ["NanoCpus", [0, 250_000_000, null]],
    ["PidMode", ["private", "host", "container:foreign", null]],
    ["OomKillDisable", [true, "false", 0, {}, []]],
    ["Memory", [null, 1]],
    ["NetworkMode", ["host", "none"]],
  ] as const) {
    for (const value of values) {
      changes.push(inspect => {(inspect.HostConfig as Record<string, unknown>)[key] = value;});
    }
  }
  for (const value of [null, true, "false"]) {
    changes.push(inspect => {(inspect.Config as Record<string, unknown>).NetworkDisabled = value;});
    for (const index of [0, 1]) {
      changes.push(inspect => {
        const host = inspect.HostConfig as Record<string, unknown>;
        (host.Mounts as Array<Record<string, unknown>>)[index]!.ReadOnly = value;
      });
    }
  }
  changes.push(inspect => {inspect.UnknownStorage = {};});
  changes.push(inspect => {
    const host = inspect.HostConfig as Record<string, unknown>;
    delete host.OomKillDisable;
  });
  changes.push(inspect => {
    const host = inspect.HostConfig as Record<string, unknown>;
    delete (host.Mounts as Array<Record<string, unknown>>)[0]!.ReadOnly;
    (inspect.Mounts as Array<Record<string, unknown>>)[0]!.RW = false;
  });
  for (const [index, change] of changes.entries()) {
    await t.test(String(index), async () => {
      const daemon = syntheticDaemon();
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      const authority = await engine.create(createInput(root), call());
      daemon.inspectTransform = change;
      await assert.rejects(engine.inspect(authority, call()), error =>
        error instanceof DockerEngineError &&
        ["authority-conflict", "malformed-response"].includes(error.code));
    });
  }

});

test("OOM null requires the evidenced current engine and cgroup identity", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  for (const [engineVersion, cgroupVersion] of [
    ["29.6.1", "1"], ["29.6.0", "2"], ["29.6.2", "2"],
    ["29.6.1-custom", "2"], ["", "2"], [null, "2"], [undefined, "2"],
    ["29.6.1", "3"], ["29.6.1", null], ["29.6.1", undefined], ["29.6.1", 2],
  ]) {
    await t.test(`${engineVersion}/${cgroupVersion}`, async () => {
      const daemon = syntheticDaemon();
      daemon.infoEngineVersion = engineVersion;
      daemon.infoCgroupVersion = cgroupVersion;
      daemon.inspectTransform = value => {
        (value.HostConfig as Record<string, unknown>).OomKillDisable = null;
      };
      const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
      await assert.rejects(engine.create(createInput(root), call()), error =>
        error instanceof DockerEngineError &&
        ["authority-conflict", "malformed-response"].includes(error.code));
    });
  }
});

test("OOM null preserves create authority during lost-response reconciliation", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  const daemon = syntheticDaemon();
  daemon.loseNextCreate = true;
  daemon.inspectTransform = value => {
    (value.HostConfig as Record<string, unknown>).OomKillDisable = null;
  };
  const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
  const authority = await engine.create(createInput(root), call());
  assert.equal((daemon.bodies[0] as {HostConfig: {OomKillDisable: unknown}}).HostConfig.OomKillDisable, false);
  assert.equal((await engine.inspect(authority, call())).existence, "present");
  daemon.inspectTransform = undefined;
  assert.equal((await engine.inspect(authority, call())).existence, "present");
});

test("lost create reconciles omitted defaults but never a read-only workspace downgrade", async t => {
  const root = await disposable();
  t.after(async () => {await rm(root, {force: true, recursive: true});});
  for (const downgrade of [false, true]) {
    const daemon = syntheticDaemon();
    daemon.loseNextCreate = true;
    daemon.inspectTransform = value => {
      delete (value.Config as Record<string, unknown>).NetworkDisabled;
      const host = value.HostConfig as Record<string, unknown>;
      const mounts = host.Mounts as Array<Record<string, unknown>>;
      delete mounts[1]!.ReadOnly;
      if (downgrade) {
        // Even agreeing configured/observed RW cannot replace the requested authority.
        delete mounts[0]!.ReadOnly;
        (value.Mounts as Array<Record<string, unknown>>)[0]!.RW = true;
      }
    };
    const engine = new NodeUnixSocketDockerEngine({client: daemon.client, policy: policy(root)});
    const creating = engine.create({...createInput(root), workspaceWritable: false}, call());
    if (downgrade) {
      await assert.rejects(creating, {code: "create-acknowledgement-unknown"});
    } else {
      const authority = await creating;
      const observed = await engine.inspect(authority, call());
      assert.equal(observed.existence, "present");
      if (observed.existence === "present") {assert.equal(observed.resources.workspaceWritable, false);}
    }
    assert.ok(daemon.routes.includes(`GET /v1.47/containers/ar-turn-${NONCE}/json`));
    assert.equal(daemon.bodies.length, 1);
  }
});
