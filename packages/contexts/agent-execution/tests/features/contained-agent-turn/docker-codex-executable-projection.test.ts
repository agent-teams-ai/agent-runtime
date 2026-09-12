import assert from "node:assert/strict";
import test from "node:test";
import {connectionFixture, installProtocol} from "./support/docker-codex-kernel-fixture.ts";
import {createCodexAppServerLaunchPlan} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {createCodexDockerPathProjection, projectCodexDockerExecutable} from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-docker-path-projection.js";
import {dockerProviderProcessMountFacts} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {nativeFinalizerFixture} from "./support/docker-native-finalizer-fixture.ts";

test("native finalizer preserves the canary image pin for Docker projection", async t => {
  const f = await nativeFinalizerFixture(t, "/ar-provider/provider-entrypoint");
  const running = f.start();
  assert.deepEqual(await running.prepare(), {kind: "prepared"}, String(f.error));
  const prepared = running.owner.takePrepared(f.f.claimed);
  const paths = createCodexDockerPathProjection(dockerProviderProcessMountFacts(prepared.launch), f.boundary);
  assert.equal(prepared.plan.executablePath, "/ar-provider/provider-entrypoint");
  assert.equal(prepared.plan.executableSha256, f.originalPlan.executableSha256);
  assert.equal(projectCodexDockerExecutable(paths, prepared.plan.executablePath), "/ar-provider/provider-entrypoint");
  assert.equal(f.f.events.includes("provider-exec"), false);
});

test("Docker accepts the exact canary image executable through issued plan and process projection", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  f.options.plan = createCodexAppServerLaunchPlan({boundary: f.options.boundary,
    executablePath: "/ar-provider/provider-entrypoint", intentMode: f.options.plan.intentMode,
    platformTarget: f.options.platformTarget, privateRootPath: f.options.plan.privateRootPath, tmpDir: f.options.plan.tmpDir});
  installProtocol(f);
  const owner = f.owner(); t.after(() => owner.dispose());
  assert.deepEqual(await owner.provider.execute(f.input), {kind: "completed", outcome: "succeeded"});
  assert.equal(f.events.filter(event => event === "provider-exec").length, 1);
});

test("Docker executable projection retains exact pins and rejects unrelated host and image paths", async t => {
  const f = await connectionFixture(); t.after(() => f.contain());
  const paths = createCodexDockerPathProjection(dockerProviderProcessMountFacts(f.options.process.launch), f.options.boundary);
  const root = f.options.plan.privateRootPath;
  assert.equal(projectCodexDockerExecutable(paths, "/usr/local/bin/codex"), "/usr/local/bin/codex");
  assert.equal(projectCodexDockerExecutable(paths, `${root}/bin/codex`), "/agent-private/bin/codex");
  assert.equal(projectCodexDockerExecutable(paths, "/ar-provider/provider-entrypoint"), "/ar-provider/provider-entrypoint");
  for (const path of ["/opt/host/bin/codex", "/unrelated/provider-entrypoint", "/ar-provider/codex",
    "/ar-provider/../ar-provider/provider-entrypoint", "/ar-provider//provider-entrypoint",
    "/ar-provider/provider-entrypoint/", "/ar-provider/provider-entrypoint\0", `${root}/bin/other`]) {
    assert.throws(() => projectCodexDockerExecutable(paths, path), /path projection rejected/u);
  }
  assert.throws(() => projectCodexDockerExecutable({...paths}, "/ar-provider/provider-entrypoint"), /path projection rejected/u);
});
