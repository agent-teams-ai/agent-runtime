// Disposable TEST-only second Host process for the S2.0/M08 RED oracle.
// It does not start a real provider, create a production owner, or qualify a public Host.
import {Pool} from "pg";
import {PostgresHttpEgressEvidence} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/postgres-http-egress-evidence.js";
import {openAuthenticatedHostHttpEgressSession} from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-egress-session.js";
import {chunks, createEgressFixture} from "./http-egress-test-fixture.ts";

type ReplayCommand = Readonly<{databaseUrl: string; originalAttemptId: string; originalRequestId: string;
  attemptId: string; requestId: string}>;
const scope = {tenantId: "tenant-1", projectId: "project-1", deploymentId: "deployment-1"};

const replay = async ({databaseUrl, originalAttemptId, originalRequestId, attemptId, requestId}: ReplayCommand) => {
  const pool = new Pool({connectionString: databaseUrl, connectionTimeoutMillis: 5_000, max: 2});
  try {
    const fixture = createEgressFixture();
    const evidence = new PostgresHttpEgressEvidence(pool, scope);
    const originalSelector = {operationId: fixture.operation.operationId, attemptId: originalAttemptId,
      requestId: originalRequestId};
    const selector = {...originalSelector, attemptId, requestId};
    const original = await evidence.read(originalSelector);
    const host = openAuthenticatedHostHttpEgressSession({...fixture.ports, evidence,
      // Distinct concurrent OS processes must not reuse a synthetic Host boot ID.
      identity: {...fixture.ports.identity, attemptId, hostBootId: `boot-B-after-UNKNOWN-${process.pid}`,
        liveProcessSessionIdentity: {}}});
    try {
      const bearer = host.nativeBearerToken();
      const wire = "POST /invoke HTTP/1.1\r\nHost: broker.invalid\r\nContent-Type: application/json\r\nContent-Length: 2\r\nAuthorization: Bearer " + bearer + "\r\n\r\n{}";
      const receipt = await host.execute({...fixture.operation, attemptId,
        expectedRequest: {...fixture.operation.expectedRequest, requestId},
        connection: {...fixture.operation.connection, request: chunks([wire])}});
      const after = await evidence.read(originalSelector);
      const replayReceipt = await evidence.read(selector);
      return {ok: true, pid: process.pid, originalKind: original.kind,
        dispatches: fixture.observations.dispatches, outcome: receipt.outcome,
        materializationInputs: fixture.observations.materializationInputs.length,
        credentialRenders: fixture.observations.renders,
        retainedSame: JSON.stringify(after) === JSON.stringify(original),
        replayReceiptKind: replayReceipt.kind};
    } finally {host.close();}
  } finally {await pool.end();}
};

process.once("message", (command: ReplayCommand) => {
  void replay(command).then(
    report => process.send?.(report, () => {process.disconnect?.();}),
    () => process.send?.({ok: false}, () => {process.disconnect?.();}),
  );
});
