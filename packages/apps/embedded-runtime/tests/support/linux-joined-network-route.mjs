import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {openJoinedNetwork} from "./linux-joined-network.mjs";
import {createDockerLinuxExclusiveRouteAdmission} from
  "@agent-teams/agent-execution/composition";
import {linuxExclusiveRouteSeccomp} from
  "@agent-teams/agent-execution/composition";
import {container, subject} from "./external/agent-execution/fixtures/host-http-egress-v4-fixture.ts";

// Explicit Linux integration entrypoint, invoked in its own outer namespace.
// The Docker inspection boundary is synthetic. Namespace, tools, rules, sockets,
// first-write reservation and cleanup are actual production/OS implementations.
// This is a prerequisite fixture check, not a successful provider turn.
const network = await openJoinedNetwork();
let removed = false;
let otherRequests = 0;
const broker = createServer((_request, response) => response.end("joined-broker"));
const other = createServer((_request, response) => {otherRequests++; response.end("unexpected");});
const binding = {
  tenantId: "tenant:test", projectId: "project:test", scopeDigest: "scope:test", operationId: "operation:test",
  attemptId: "attempt:test", custodyId: "custody:test", sourceRevision: "bada36eab755ec44766420af5009e7019bc291ff",
  binaryRevision: "@openai/codex:0.153.4+linux-x64", hostBootId: "boot:test", executionGenerationId: "generation:test",
  adapterRevision: "adapter:test", capabilityManifestRevision: "manifest:test", authorityVectorDigest: "authority:test",
  providerAccountRef: "account:test", accessRef: "access:test", bindingRevision: 3, credentialBindingRef: "credential:test",
  providerRouteRef: "route:test", routeRevision: "revision:1", credentialBindingDigest: "pa-opaque-binding:test",
  credentialGeneration: 7,
};
const route = createDockerLinuxExclusiveRouteAdmission({binding, nsenter: network.nsenter, nft: network.nft,
  engine: {async inspect(authority) {
    assert.deepEqual(authority, container);
    const facts = {authority, engine: {...subject.attempt, cgroupVersion: "2"}, cgroupTree: "unobserved"};
    return removed ? {...facts, existence: "absent"} : {...facts, existence: "present",
      state: {running: true, hostPid: network.pid, startedAt: "2026-01-01T00:00:00Z"},
      resources: {seccompProfileSha256: linuxExclusiveRouteSeccomp().sha256}};
  }},
});
try {
  broker.listen(0, network.gateway); other.listen(0, network.gateway);
  await Promise.all([once(broker, "listening"), once(other, "listening")]);
  const endpoint = {address: network.gateway, port: broker.address().port};
  const installed = await route.admit({authority: container, endpoint, signal: new AbortController().signal,
    deadlineEpochMs: Date.now() + 5000, lifetimeMs: 20000});
  assert.equal(installed.kind, "installed");
  const firstWrite = installed.firstWrite.reserve("joined-request");
  assert.equal(firstWrite.consume(), true); assert.equal(firstWrite.consume(), false);
  const success = await network.request(`http://${endpoint.address}:${endpoint.port}/`);
  assert.equal(success.status, 200); assert.equal(success.text, "joined-broker");
  const denied = await network.request(`http://${endpoint.address}:${other.address().port}/`, 500);
  assert.equal(denied.error, "TimeoutError"); assert.equal(otherRequests, 0);
  assert.equal(installed.owner.revoke(), "closed");
  const revoked = await network.request(`http://${endpoint.address}:${endpoint.port}/`, 500);
  assert.equal(revoked.error, "TimeoutError");
  await network.dispose(); removed = true;
  assert.equal(await route.releaseAfterContainerRemoval(), "closed");
  console.log(JSON.stringify({route: "installed", broker: "passed", other: "dropped", revoked: "dropped", cleanup: "closed"}));
} finally {
  await network.dispose(); removed = true;
  await route.releaseAfterContainerRemoval();
  for (const server of [broker, other]) {
    server.closeAllConnections(); await new Promise(resolve => {server.close(resolve);});
  }
}
