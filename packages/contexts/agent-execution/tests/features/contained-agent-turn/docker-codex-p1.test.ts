import {dockerProviderProcessMountFacts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync, writeFileSync, symlinkSync} from "node:fs";
import {join} from "node:path";
import {brokerFixture, fixtureCapability, nativeBrokerConfig} from "../../fixtures/codex-native-broker-0.153.4/fixture.ts";
import {createCodexAppServerLaunchPlan, codexNativeBrokerLaunchInput}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {createCodexDockerPathProjection, bindCodexDockerProtocolBoundary}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-docker-path-projection.js";
import {observeCodexWorkspaceEndpoint, diagnoseCodexWorkspaceEndpoint}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-path-identity.js";
import {createCodexNativeBrokerRecipe, renderCodexNativeBrokerConfig}
  from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-recipe.js";
import {prepareCodexNativeBrokerFiles} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-native-broker-files.js";
import {connectionFixture, installProtocol} from "./support/docker-codex-kernel-fixture.ts";
import {deferred, tick, fixture} from "./support/docker-provider-process-fixture.ts";

test("P1A production mounts determine child HOME and workspace paths", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  const mounts = (f.encodedCreate!.HostConfig as {Mounts: {Source: string; Target: string}[]}).Mounts;
  assert.deepEqual(mounts.map(({Source, Target}) => ({Source, Target})), [
    {Source: f.options.boundary.workspaceRef, Target: "/workspace"},
    {Source: f.options.plan.privateRootPath, Target: "/agent-private"},
  ]);
  assert.match(mounts[0]!.Source, /Docker é 😀 /u);
  installProtocol(f);
  assert.deepEqual(await f.owner().provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
  const exec = f.channel.messages.find(message => message.kind === "provider-exec");
  assert.equal(exec?.kind, "provider-exec");
  if (exec?.kind !== "provider-exec") {return;}
  assert.equal(exec.environment.find(entry => entry.name === "CODEX_HOME")?.value, "/agent-private/codex-home");
  assert.equal(exec.environment.find(entry => entry.name === "HOME")?.value, "/agent-private/codex-home");
  assert.equal(exec.environment.find(entry => entry.name === "TMPDIR")?.value, "/agent-private/tmp");
  assert.equal(exec.argv[0], "/usr/local/bin/codex");
  assert.equal(exec.executableSha256, f.options.plan.executableSha256);
  const writes = f.channel.messages.filter(message => message.kind === "provider-input")
    .map(message => JSON.parse(Buffer.from(message.bytesBase64, "base64").toString()));
  assert.equal(writes.find(message => message.method === "thread/start").params.cwd, "/workspace");
});

for (const mode of ["analysis", "workspace-write"] as const) {
  test(`P1A ${mode} native files keep Host custody with exact child config`, async t => {
    const f = await connectionFixture(brokerFixture(t, mode)); t.after(() => f.contain());
    const {recipe} = codexNativeBrokerLaunchInput(f.options.plan);
    const config = readFileSync(join(f.options.plan.codexHome, "config.toml"), "utf8");
    assert.equal(config, renderCodexNativeBrokerConfig(recipe));
    assert.equal(recipe.catalogPath, "/agent-private/codex-home/models.json");
    assert.ok(config.includes('model_catalog_json = "/agent-private/codex-home/models.json"'));
    assert.ok(config.includes('"/agent-private/codex-home" = "deny"'));
    assert.ok(!config.includes(f.options.plan.privateRootPath));
    assert.ok(!config.includes(fixtureCapability));
    const paths = createCodexDockerPathProjection(dockerProviderProcessMountFacts(f.launched), f.options.boundary);
    const view = bindCodexDockerProtocolBoundary(f.options.boundary, paths);
    assert.equal(view.workspaceIdentity, f.options.boundary.workspaceIdentity);
    const hostFile = join(f.options.boundary.workspaceRef, "answer.txt");
    writeFileSync(hostFile, "synthetic artifact");
    const endpoint = observeCodexWorkspaceEndpoint("/workspace/answer.txt", view);
    assert.equal(endpoint.path, hostFile);
    assert.equal(observeCodexWorkspaceEndpoint(hostFile, f.options.boundary).path, hostFile, "Node retains Host paths");
    diagnoseCodexWorkspaceEndpoint(endpoint.endpointObservation, view);
    for (const value of [hostFile, "/workspace/../private/file", "/workspace-other/file", "/agent-private/codex-home/models.json"]) {
      assert.throws(() => observeCodexWorkspaceEndpoint(value, view));
    }
    symlinkSync(hostFile, join(f.options.boundary.workspaceRef, "alias"));
    assert.throws(() => observeCodexWorkspaceEndpoint("/workspace/alias", view));
    installProtocol(f);
    const respond = f.channel.onMessage!;
    f.channel.onMessage = message => {
      if (message.kind === "provider-input") {f.channel.outputBytes("stderr", `${fixtureCapability}\n`);}
      return respond(message);
    };
    assert.deepEqual(await f.owner().provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
    assert.ok(!JSON.stringify(f.output).includes(fixtureCapability), "the exact native plan still supplies the private capability inventory");
    assert.equal(f.engine.running, true);
    assert.equal((await f.contain()).kind, "closed");
  });
}

for (const mutation of ["config-bytes", "models-bytes", "host-config-response", "origin-hash", "legacy-recipe"] as const) {
  test(`P1A native ${mutation} cannot fall back or bypass exact material`, async t => {
    const f = await connectionFixture(brokerFixture(t)); t.after(() => f.contain());
    const requests = installProtocol(f);
    if (mutation === "legacy-recipe") {
      const recipe = createCodexNativeBrokerRecipe({boundary: f.options.boundary,
        endpoint: "http://10.203.0.1:43129/backend-api/codex", profile: "codex-chatgpt"});
      writeFileSync(join(f.options.plan.codexHome, "config.toml"), renderCodexNativeBrokerConfig(recipe));
      const files = await prepareCodexNativeBrokerFiles(recipe);
      f.options.plan = createCodexAppServerLaunchPlan({boundary: f.options.boundary,
        executablePath: f.options.plan.executablePath, intentMode: "analysis", platformTarget: f.options.platformTarget,
        privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
        nativeBroker: {recipe, files, localCapability: fixtureCapability}});
      assert.throws(() => f.owner(), /child paths/u); return;
    }
    const owner = f.owner();
    if (mutation === "config-bytes" || mutation === "models-bytes") {
      writeFileSync(join(f.options.plan.codexHome, mutation === "config-bytes" ? "config.toml" : "models.json"), "substituted");
    } else {
      const respond = f.channel.onMessage!;
      f.channel.onMessage = message => {
        if (message.kind === "provider-input") {
          const request = JSON.parse(Buffer.from(message.bytesBase64, "base64").toString());
          if (request.method === "config/read") {
            const result = nativeBrokerConfig(mutation === "host-config-response" ? f.options.plan.codexHome : "/agent-private/codex-home");
            if (mutation === "origin-hash") {Object.values(result.origins)[0]!.version = `sha256:${"0".repeat(64)}`;}
            f.channel.outputBytes("stdout", `${JSON.stringify({id: request.id, result})}\n`); return;
          }
        }
        return respond(message);
      };
    }
    assert.equal((await owner.provider.execute(f.input)).kind, "indeterminate");
    assert.ok(!requests.includes("turn/start"));
    if (mutation.endsWith("-bytes")) {assert.equal(f.events.includes("provider-exec"), false);}
  });
}

test("P1A only the bounded image or retained private executable location is admitted", async t => {
  for (const path of ["/usr/bin/codex", "/tmp/codex", "/workspace/codex", "private-mapped"]) {
    const f = await connectionFixture(); t.after(() => f.contain());
    const executablePath = path === "private-mapped" ? `${f.options.plan.privateRootPath}/bin/codex` : path;
    f.options.plan = createCodexAppServerLaunchPlan({boundary: f.options.boundary, executablePath,
      intentMode: "analysis", platformTarget: f.options.platformTarget,
      privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir});
    if (path !== "private-mapped") {assert.throws(() => f.owner(), /projection rejected/u);}
    else {
      // Stop at exec acknowledgement: this asserts the actual wire mapping without executing a binary.
      f.channel.onMessage = message => {
        if (message.kind === "provider-exec") {
          assert.equal(message.argv[0], "/agent-private/bin/codex");
          assert.equal(message.executableSha256, f.options.plan.executableSha256);
          f.channel.push({kind: "provider-exec-ack", requestId: message.requestId, observation: "not-started"});
        } else {f.channel.respond(message);}
      };
      assert.equal((await f.owner().provider.execute(f.input)).kind, "indeterminate");
      assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
    }
    assert.equal(f.events.includes("provider-input"), false);
  }
});

test("P1A projection is tied to actual retained mount facts and native launch identity", async t => {
  for (const mutation of ["retained-private-root", "same-strings-other-launch", "copied-projection", "copied-mounts", "caller-create-mutation"] as const) {
    const f = await connectionFixture(brokerFixture(t)); t.after(() => f.contain());
    if (mutation === "copied-projection") {
      const projection = createCodexDockerPathProjection(dockerProviderProcessMountFacts(f.launched), f.options.boundary);
      assert.throws(() => bindCodexDockerProtocolBoundary(f.options.boundary, {...projection})); continue;
    }
    if (mutation === "copied-mounts") {
      const recipe = createCodexNativeBrokerRecipe({boundary: f.options.boundary,
        endpoint: "http://10.203.0.1:43129/backend-api/codex", profile: "codex-chatgpt",
        dockerMounts: {...dockerProviderProcessMountFacts(f.launched)}});
      const files = await prepareCodexNativeBrokerFiles(recipe);
      f.options.plan = createCodexAppServerLaunchPlan({boundary: f.options.boundary,
        executablePath: f.options.plan.executablePath, intentMode: "analysis", platformTarget: f.options.platformTarget,
        privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir,
        nativeBroker: {recipe, files, localCapability: fixtureCapability}});
      assert.throws(() => f.owner(), /child paths/u);
      assert.equal(f.events.includes("provider-exec"), false); continue;
    }
    if (mutation === "caller-create-mutation") {
      const create = f.launchInput.create as {privateRootSource: string}; create.privateRootSource = "/substituted";
      const init = f.options.process.init; const isCurrentGeneration = init.isCurrentGeneration;
      installProtocol(f); const owner = f.owner();
      // The caller cannot replace the captured generation callback after construction.
      (init as {isCurrentGeneration: typeof isCurrentGeneration}).isCurrentGeneration = () => false;
      assert.deepEqual(await owner.provider.execute(f.input), {kind: "completed", outcome: "succeeded"}); continue;
    }
    const other = fixture();
    const create = other.launchInput.create as {workspaceSource: string; privateRootSource: string};
    create.workspaceSource = f.options.boundary.workspaceRef;
    create.privateRootSource = f.options.plan.privateRootPath + (mutation === "retained-private-root" ? "/wrong" : "");
    const opened = await other.launch(); t.after(() => opened.contain());
    f.options.process = opened.input;
    assert.throws(() => f.owner(), mutation === "retained-private-root" ? /projection rejected|retained mount/u : /child paths/u);
    assert.equal(other.events.includes("provider-exec"), false);
  }
});

for (const cutoff of ["dispose", "call-abort", "init-abort", "generation"] as const) {
  for (const stage of ["deferred-creation", "late-publication", "queued-write", "subsequent-request"] as const) {
    test(`P1B ${cutoff} at ${stage} closes actual protocol admission`, async t => {
      const f = await connectionFixture(); t.after(() => f.contain());
      const controller = new AbortController(); let current = true;
      if (cutoff === "call-abort") {f.options.process.call = {...f.options.process.call, signal: controller.signal};}
      f.options.process.init = {...f.options.process.init, isCurrentGeneration: () => current,
        ...(cutoff === "init-abort" ? {signal: controller.signal} : {})};
      const requests = installProtocol(f); const respond = f.channel.onMessage!;
      const owner = f.owner();
      const close = () => {if (cutoff === "dispose") {owner.dispose();} else if (cutoff === "generation") {current = false;} else {controller.abort();}};
      if (stage === "queued-write") {f.transport.beforeProtocolWrite = () => {queueMicrotask(close);};}
      const reached = deferred(); let release!: () => void;
      f.channel.onMessage = message => {
        if (stage === "deferred-creation" && message.kind === "provider-exec") {
          release = () => {void respond(message);}; reached.resolve(); return;
        }
        const result = respond(message);
        if (stage === "subsequent-request" && requests.length === 1) {close();}
        return result;
      };
      let checks = 0;
      const pending = owner.provider.execute({...f.input, isCancellationRequested: async () => {
        if (++checks === 2 && stage === "late-publication") {queueMicrotask(() => queueMicrotask(close));}
        return false;
      }});
      if (stage === "deferred-creation") {await reached.promise; close(); release();}
      assert.equal((await pending).kind, "indeterminate"); await tick();
      assert.deepEqual(requests, stage === "subsequent-request" ? ["initialize"] : []);
      if (stage !== "subsequent-request") {assert.equal(f.events.includes("provider-input"), false);}
      assert.deepEqual(f.output, []);
      assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
      assert.equal(f.engine.running, true, "IO closure is not physical containment");
      assert.equal((await f.contain()).kind, "closed");
    });
  }
}

test("P1B nested microtask disposal before publication sends no first protocol byte", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  const requests = installProtocol(f); const owner = f.owner(); let checks = 0;
  const outcome = await owner.provider.execute({...f.input, isCancellationRequested: async () => {
    if (++checks === 2) {queueMicrotask(() => queueMicrotask(() => {
      assert.deepEqual(requests, []); owner.dispose();
    }));}
    return false;
  }});
  assert.deepEqual(requests, []);
  assert.equal(f.events.includes("provider-input"), false);
  assert.equal(outcome.kind, "indeterminate");
});

test("P1C launch accessors cannot substitute a different container after native validation", async t => {
  const f = await connectionFixture(brokerFixture(t)); t.after(() => f.contain());
  const other = fixture();
  const create = other.launchInput.create as {workspaceSource: string; privateRootSource: string};
  create.workspaceSource = f.options.boundary.workspaceRef;
  create.privateRootSource = f.options.plan.privateRootPath;
  const opened = await other.launch(); t.after(() => opened.contain());
  let reads = 0;
  f.options.process = {...opened.input, get launch() {return ++reads <= 2 ? f.launched : opened.launched;}};
  assert.throws(() => f.owner(), /rejected/u);
  assert.equal(reads, 0, "capture must reject getters without invoking them");
  assert.equal(other.events.includes("provider-exec"), false);
});

test("P1C process proxies are rejected before invoking any trap", async t => {
  const f = await connectionFixture(); t.after(() => f.contain()); let traps = 0;
  f.options.process = new Proxy(f.options.process, {
    get() {traps += 1; throw new Error("trap invoked");},
    ownKeys() {traps += 1; throw new Error("trap invoked");},
    getPrototypeOf() {traps += 1; throw new Error("trap invoked");},
  });
  assert.throws(() => f.owner(), /rejected/u); assert.equal(traps, 0);
});
