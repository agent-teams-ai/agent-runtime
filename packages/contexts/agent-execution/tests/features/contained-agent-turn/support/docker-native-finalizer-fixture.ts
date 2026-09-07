import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import type {TestContext} from "node:test";
import {postClaimFixture} from "./docker-linux-post-claim-fixture.ts";
import {createEgressFixture} from "../http-egress-test-fixture.ts";
import {headers} from "../native-http-request-profile-fixture.ts";
import {createCodexAppServerPermissionBoundary} from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {createCodexAppServerFinalizableLaunchPlan, renderCodexNativeBrokerConfig}
  from "../../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import {createNativeHttpEgressRoute} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {prepareDockerProviderProcessIo} from "../../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {createDockerLinuxPostClaimOwner} from "../../../../dist/features/contained-agent-turn/composition/docker-linux-post-claim-preparation.js";
import {createDockerCodexNativeBrokerFinalizer, type DockerCodexNativeBrokerFinalizerInput}
  from "../../../../dist/features/contained-agent-turn/composition/docker-codex-native-broker-finalizer.js";
import type {CreateDockerCodexHostKernelOwnerOptions} from "../../../../dist/features/contained-agent-turn/composition/docker-codex-host-kernel-owner.js";

type FinishInput = Parameters<NonNullable<CreateDockerCodexHostKernelOwnerOptions["finishClaimed"]>>[0];
/** Component evidence only: new disposable native files plus the actual Docker
 * lifecycle/sole init reader, HTTP resources, V4, native issuers and broker.
 * Engine, listener, route enforcement, PA/RS and upstream IO are synthetic. */
export const nativeFinalizerFixture = async (t: TestContext) => {
  const f = await postClaimFixture(t);
  const root = realpathSync(mkdtempSync("/tmp/ar69-native-finalizer-component-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const privateRootPath = `${root}/private`; const codexHome = `${privateRootPath}/home`;
  const tmpDir = `${privateRootPath}/tmp`; const workspaceRef = `${root}/workspace`;
  for (const path of [privateRootPath, codexHome, tmpDir, workspaceRef]) {mkdirSync(path, {mode: 0o700});}
  const boundary = createCodexAppServerPermissionBoundary({codexHome, workspaceRef, intentMode: "analysis"});
  const route = createNativeHttpEgressRoute("codex-chatgpt-responses/v1", "synthetic-route-receipt");
  const scope = {tenantId: f.proof.tenantId, projectId: f.proof.projectId, operationId: f.proof.operationId, scopeDigest: "scope-digest"};
  const egress = createEgressFixture({route,
    mutateProvisional: decision => ({...decision, scope, signingKey: {...decision.signingKey, hostReservationId: f.proof.custodyId},
      signature: {...decision.signature, hostReservationId: f.proof.custodyId}}),
    mutateGrant: grant => ({...grant, signature: {...grant.signature, hostReservationId: f.proof.custodyId},
      evidence: {...grant.evidence, signingKey: {...grant.evidence.signingKey, hostReservationId: f.proof.custodyId}}, payload: {...grant.payload, scope, consumption: {...grant.payload.consumption,
      journalKey: {...grant.payload.consumption.journalKey, tenantId: scope.tenantId, projectId: scope.projectId, operationId: scope.operationId}}}}),
  });
  const snapshot = {...egress.ports.providerAccessSnapshot, tenantId: scope.tenantId, projectId: scope.projectId};
  const session = {...egress.ports, providerAccessSnapshot: snapshot,
    verifier: {...egress.ports.verifier, signingKey: {...egress.ports.verifier.signingKey, hostReservationId: f.proof.custodyId}},
    materializer: {renders: 0, async render() {this.renders += 1; return [
      {name: "authorization", valueBytes: Buffer.from("Bearer synthetic-upstream-only")},
      {name: "chatgpt-account-id", valueBytes: Buffer.from("synthetic-account")},
    ];}},
  };
  const options = {boundary, executablePath: "/usr/local/bin/codex", intentMode: "analysis" as const,
    platformTarget: {architecture: "x64", platform: "linux"} as const, privateRootPath, tmpDir};
  const originalPlan = createCodexAppServerFinalizableLaunchPlan(options, snapshot);
  const record = {...options, credentialOutputInventory: {credentialBindingDigest: "synthetic-binding",
    credentialGeneration: snapshot.credentialGeneration, sensitiveOutputTokens: []}};
  const writes: string[] = []; const reservations: string[] = []; let consumes = 0;
  const lease = {reserveFirstWrite(_binding: unknown, requestId: string) {
    reservations.push(requestId); let used = false;
    return {consume() {if (used) {return false;} used = true; consumes += 1; return true;}};
  }};
  f.route.lease = Object.freeze({...f.syntheticLease(), ...lease}); f.route.release = "closed";
  const nativeFiles = {async install(recipe: Parameters<DockerCodexNativeBrokerFinalizerInput["nativeFiles"]["install"]>[0]) {
    writes.push(recipe.endpoint);
    writeFileSync(`${codexHome}/config.toml`, renderCodexNativeBrokerConfig(recipe), {mode: 0o600});
    writeFileSync(`${codexHome}/models.json`, readFileSync(new URL("../../../fixtures/codex-native-broker-0.153.4/models.json", import.meta.url)), {mode: 0o600});
  }};
  const input = {session, nativeFiles, routeAdmission: f.dependencies.routeAdmission!};
  let finishInput: FinishInput | undefined; let error: unknown;
  let prepareIoCount = 0;
  const start = (finalizer = createDockerCodexNativeBrokerFinalizer(input), change: (value: FinishInput) => FinishInput = value => value) => {
    const owner = createDockerLinuxPostClaimOwner({...f.dependencies,
      create: {...f.dependencies.create, workspaceSource: workspaceRef, privateRootSource: privateRootPath},
      routeAdmission: finalizer.routeAdmission,
      resources: {...f.dependencies.resources, consumption: {async prepare() {
        return {kind: "ready" as const, journal: session.journal, quarantine() {}, async retire() {return "retired" as const;}};
      }}, localCut: {...f.dependencies.resources.localCut,
        expectedClock: {authorityId: "clock-authority", epoch: "epoch-1"},
        clock: {read: () => ({authorityId: "clock-authority", epoch: "epoch-1", controlTime: 1}),
          within: session.clock.within}}},
    }, {
      prepareProviderIo({launch, init}) {
        prepareIoCount += 1;
        return prepareDockerProviderProcessIo({launch, init, expected: {authority: launch.authority,
          custodyRef: launch.key.custodyId, generation: init.authority.generation, workspaceAuthorityPath: workspaceRef}});
      },
      async finishClaimed(joined) {
        assert.equal(f.events.includes("route-admission"), true);
        finishInput = {...joined, record, originalPlan};
        try {return await finalizer.finishClaimed(change(finishInput));}
        catch (failure) {error = failure; throw failure;}
      },
    });
    t.after(async () => {finalizer.cutoff(); await owner.cleanup({deadlineEpochMs: Date.now() + 5000});});
    return {owner, finalizer, prepare: () => owner.preparation.prepareClaimed(f.claimed)};
  };
  const operation = (capability: string) => {
    const body = "{}"; const path = "/backend-api/codex/responses"; const host = "172.30.0.1:43129";
    const request = `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${capability}\r\n`
      + headers("codex").map(h => `${h.name}: ${h.value}\r\n`).join("") + `Content-Length: ${body.length}\r\n\r\n${body}`;
    const inbound = createEgressFixture({request: [request]});
    return {...inbound.operation, operationId: f.proof.operationId, attemptId: f.proof.attemptId,
      expectedRequest: {...inbound.operation.expectedRequest, method: "POST" as const, path, host}};
  };
  return {f, root, codexHome, boundary, originalPlan, record, input, writes, reservations, session, egress, start, operation,
    get finishInput() {return finishInput!;}, get error() {return error;}, get consumes() {return consumes;},
    get prepareIoCount() {return prepareIoCount;}};
};
