import assert from "node:assert/strict";
import {test} from "node:test";
import {PostgresHttpEgressEvidence} from "@agent-teams/agent-execution/composition";
import {createPreparedHttpRequestV1} from "@agent-teams/agent-execution/composition";
import {materializationAuthorizationRequest, projectPreparedRequest} from "@agent-teams/agent-execution/composition";
import {createEgressFixture} from "./support/external/agent-execution/features/contained-agent-turn/http-egress-test-fixture.ts";
import {captureCurrentEgressResolve} from "@agent-teams/runtime-security/composition";

const bytes = (value: string) => new TextEncoder().encode(value);

for (const body of ["", '{"prompt":"synthetic"}']) {
  test(`production HTTP evidence projection passes current RS validation (${body ? "body" : "empty body"})`, () => {
    const fixture = createEgressFixture();
    const evidence = new PostgresHttpEgressEvidence({async connect() {
      throw new Error("digest projection must not access PostgreSQL");
    }}, {tenantId: "tenant-1", projectId: "project-1", deploymentId: "deployment-1"});
    const ports = {...fixture.ports, evidence};
    const prepared = createPreparedHttpRequestV1({methodBytes: bytes(ports.route.upstreamMethod),
      targetBytes: bytes(ports.route.upstreamPath), hostBytes: bytes(ports.route.originHost),
      presentationFields: [{name: "content-type", valueBytes: bytes("application/json")}],
      credentialHeaderNameAllowlist: ["authorization"],
      credentialFields: [{name: "authorization", valueBytes: bytes("Bearer synthetic-only")}], bodyBytes: bytes(body)});
    const custody = prepared.consume(); assert.ok(custody);
    try {
      const request = projectPreparedRequest(ports, custody, {
        ...materializationAuthorizationRequest(ports, "materialization-1"),
        requestDigest: `sha256:${"1".repeat(64)}`, credentialBindingDigest: `sha256:${"2".repeat(64)}`,
        decision: "authorized", rejectionReason: null});
      const input = {scope: {tenantId: "tenant-1", projectId: "project-1", operationId: "operation-1",
        scopeDigest: `sha256:${"3".repeat(64)}`}, authorizationRequestId: "authorization-1", request};
      assert.deepEqual(captureCurrentEgressResolve(input).request, request);
      // Each byte digest independently gates the actual RS boundary. Restoring
      // the old production encoding must fail even when the other fields pass.
      type MutableRequest = {-readonly [K in keyof typeof request]: (typeof request)[K]};
      const mutations = [
        (value: MutableRequest) => {value.requestTarget = {...value.requestTarget, digest: value.requestTarget.digest.slice(7)};},
        (value: MutableRequest) => {value.headers = {...value.headers, canonicalDigest: value.headers.canonicalDigest.slice(7)};},
        (value: MutableRequest) => {value.body = {...value.body, digest: value.body.digest.slice(7)};},
        (value: MutableRequest) => {value.headers = {...value.headers, credentialFields: value.headers.credentialFields.map(
          field => ({...field, valueDigest: field.valueDigest.slice(7)}))};},
      ];
      for (const mutate of mutations) {
        const altered = structuredClone(request); mutate(altered);
        assert.throws(() => captureCurrentEgressResolve({...input, request: altered}), TypeError);
      }
    } finally {custody.dispose(); prepared.dispose();}
  });
}
