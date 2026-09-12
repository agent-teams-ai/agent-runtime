import assert from "node:assert/strict";
import test from "node:test";
import {rm} from "node:fs/promises";
import {disposable, policy as testPolicy, createInput, engineCall} from "./external/agent-execution/features/contained-agent-turn/support/docker-host-custody-lifecycle-fixture.ts";
import {joinedDocker} from "./linux-joined-docker.mjs";
import {postClaimFixture} from "./external/agent-execution/features/contained-agent-turn/support/docker-linux-post-claim-fixture.ts";
import {BOOT} from "./external/agent-execution/features/contained-agent-turn/support/linux-docker-residue-fixture.ts";
import {createDockerLinuxPostClaimPreparation} from "@agent-teams/agent-execution/composition";

// Synthetic Engine/kernel metadata only. This exercises the test IO through
// concrete production owners; it makes no live Docker or route qualification.
test("joined Docker IO uses the concrete lifecycle and retained init channel", async t => {
  const fixture = await postClaimFixture(t);
  let disposals = 0;
  const network = {pid: 4242, gateway: "172.30.0.1", async dispose() {disposals += 1;}};
  const root = await disposable();
  t.after(() => rm(root, {recursive: true, force: true}));
  const create = createInput(root);
  const policy = {...testPolicy(root), cgroupParent: "agent-runtime.slice"};
  const docker = joinedDocker({policy,
    create, network, bootId: BOOT});
  t.after(() => docker.dispose());
  fixture.route.lease = fixture.syntheticLease();
  let lifecycle; let launched;
  const dependencies = {...fixture.dependencies, create, enginePolicy: policy, engineClient: docker.client,
    engineIdentity: docker.engineIdentity, openLifecycle(boundPolicy) {
      lifecycle = docker.openLifecycle(boundPolicy);
      const launch = lifecycle.launch.bind(lifecycle);
      lifecycle.launch = async input => {launched = await launch(input); return launched;};
      return lifecycle;
    },
    async openResourceJournal(input) {docker.bindSubject(input.subject); return fixture.dependencies.openResourceJournal(input);}};
  const preparation = createDockerLinuxPostClaimPreparation(dependencies);
  const result = await preparation.prepareClaimed(fixture.claimed);
  assert.deepEqual(result, {kind: "prepared"}, JSON.stringify({events: fixture.events, io: docker.io.events, messages: docker.messages}));
  assert.equal(docker.messages.filter(message => message.kind === "host-handshake").length, 1);
  assert.equal(docker.messages.filter(message => message.kind === "provider-exec").length, 0);
  assert.equal(disposals, 0);
  fixture.controller.abort();
  const cleanup = await lifecycle.contain({authority: launched.authority, key: launched.key, call: engineCall()});
  assert.equal(cleanup.kind, "closed");
  assert.ok(disposals > 0);
});
