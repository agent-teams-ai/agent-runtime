import type { ContainedTurnEgress, ContainedTurnEgressDependencies, ContainedTurnEgressResult,
  TrustedEgressHostIdentityV1 } from "./composition.js";
import { createEgressValidation, type EgressSecurityPrimitives } from "./validation.js";
import { EgressOneShotLifecycle } from "./lifecycle.js";
import { captureClose } from "./node-boundary.js";
import { deny, uncertain } from "./results.js";
import { prepareExchange } from "./prepare.js";
import { createFirstWriteBoundary } from "./first-write.js";
import { completeExchange } from "./complete-exchange.js";
const freeze = Object.freeze;

export const createContainedTurnEgressGatewayCore = (trustedIdentity: TrustedEgressHostIdentityV1,
  dependencies: ContainedTurnEgressDependencies, primitives: EgressSecurityPrimitives): ContainedTurnEgress => {
  const validation = createEgressValidation(primitives); const captured = validation.captureComposition(trustedIdentity, dependencies);
  const owners = captured.dependencies; const lifecycle = new EgressOneShotLifecycle();
  const run = async (unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]): Promise<ContainedTurnEgressResult> => {
    const prepared = await prepareExchange(unsafe, validation, owners, lifecycle);
    if ("status" in prepared) {return prepared;}
    const {request, route, policy, capturedRequest} = prepared;
    if (!lifecycle.active) {return deny("authority_drift");}
    try {const acquired = await lifecycle.owner(async () => {
        const session = await owners.transportGateway.openOneShotHttps();
        lifecycle.retainClose(captureClose(session)); return session;
      }, true);
      const session = validation.captureTransport(acquired);
      if (session !== undefined) {lifecycle.attach(session);}}
    catch {lifecycle.markUsed(); return deny("transport_denied");}
    const transport = lifecycle.transport;
    if (transport === undefined || lifecycle.writeExact === undefined) {lifecycle.markUsed();
      return await lifecycle.closeTransport() ? deny("transport_denied") : uncertain("close_failed");}
    if (!lifecycle.active) {return await lifecycle.closeTransport() ? deny("authority_drift") : uncertain("close_failed");}

    const boundary = createFirstWriteBoundary({owners, request, route, policy, capturedRequest,
      identity: captured.identity, validation, lifecycle, primitives});
    let result; let returnedWhilePending = false;
    try {result = validation.snapshotTransportResult(await lifecycle.owner(() => transport.execute(freeze({target: freeze({scheme: route.scheme,
      host: route.host, port: route.port, tlsServerName: route.tlsServerName, path: request.path}), request: capturedRequest.buffered,
      responseByteLimit: request.budgets.responseBytes, deadlineMs: request.budgets.deadlineMs, beforeFirstWrite: boundary.beforeFirstWrite}))));
      returnedWhilePending = boundary.callbackPending;
    } catch {result = freeze({status: "write_indeterminate" as const});}
    await boundary.finish(); const interrupted = !lifecycle.active;
    const closed = await lifecycle.closeTransport(); lifecycle.releaseTransport();
    return completeExchange({result, closed, interrupted, returnedWhilePending, lifecycle, boundary, capturedRequest});
  };
  return freeze({exchange(unsafe: Parameters<ContainedTurnEgress["exchange"]>[0]) {
    if (!lifecycle.activate()) {return Promise.resolve(deny("invalid_request"));}
    let settle!: (value: ContainedTurnEgressResult) => void;
    const flight = new Promise<ContainedTurnEgressResult>(resolve => {settle = resolve;});
    lifecycle.track(flight);
    void run(unsafe).then(settle, async () => {lifecycle.quarantine();
      const closed = await lifecycle.closeTransport(); settle(uncertain(closed ? "first_write_indeterminate" : "close_failed"));});
    return flight;
  }, dispose: () => lifecycle.dispose()});
};
