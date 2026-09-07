import type { ConsumeForDispatchInput, ConsumeForDispatchOutcome, ObserveDispatchConsumptionInput,
  SettleDispatchConsumptionInput, SettleDispatchConsumptionOutcome } from "../contracts/dispatch-consumption-v1.js";
import { consumeCommandFromContract, observeInputFromContract, settlementInputFromContract } from "../adapters/inbound/dispatch-consumption-mapper.js";
import { canonicalJson, claimBindingDigestPayload, requestDigestPayload } from "../domain/dispatch-consumption.js";
import type { PaAcceptedPreparation, PaDispatchIssuanceSelection, PaOperationStore } from "../adapters/outbound/dispatch-operation-contracts.js";
import { assertPaCurrentMaterialization, assertPaPreparedRequest, paPublication, snapshotPaIssuance,
  snapshotPaPreparation, verifiedPaPublication } from "../adapters/outbound/dispatch-operation-data.js";
import { createOperationDispatchRepository, samePaOwner } from "../adapters/outbound/dispatch-operation-repository.js";
import { createSha256DispatchConsumptionDigest } from "../adapters/outbound/sha256-dispatch-consumption-digest.js";
import { createContainedTurnDispatchConsumptionV1 } from "./dispatch-consumption-v1-factory.js";

const conflict = (): ConsumeForDispatchOutcome => Object.freeze({kind: "conflict", reason: "grant_request_digest_conflict"});
/** Private composition; issuance provisioning is an explicit independent control action. */
export const createOperationDispatchConsumption = (store: PaOperationStore, selection: PaDispatchIssuanceSelection) => {
  const issuance = snapshotPaIssuance(selection);
  const {provider, tenantId, projectId, scopeDigest} = issuance.binding;
  const owner = Object.freeze({provider, scope: Object.freeze({tenantId, projectId, scopeDigest})});
  const digest = createSha256DispatchConsumptionDigest();
  const feature = (operationId: string, command?: ReturnType<typeof consumeCommandFromContract>) => createContainedTurnDispatchConsumptionV1({
    digest, repository: createOperationDispatchRepository(store, owner, operationId, command),
  });
  const consumeForDispatch = async (input: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> => {
    let command;
    try {command = consumeCommandFromContract(input);}
    catch {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
    return feature(command.operationId, command).consumeForDispatch(command);
  };
  return Object.freeze({
    dispatchConsumption: Object.freeze({
      consumeForDispatch,
      async publishAndConsumeForDispatch(input: PaAcceptedPreparation, request: ConsumeForDispatchInput): Promise<ConsumeForDispatchOutcome> {
        let prepared; let command;
        try {
          prepared = snapshotPaPreparation(input); command = consumeCommandFromContract(request);
          if (!samePaOwner(prepared, owner)) {return conflict();}
          await assertPaPreparedRequest(prepared, command);
          const {requestDigest: _requestDigest, ...semantic} = command;
          if (command.requestDigest !== await digest.digest(requestDigestPayload(semantic)) ||
            command.claimBindingDigest !== await digest.digest(claimBindingDigestPayload(command))) {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
        } catch {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
        try {
          const accepted = prepared;
          const acknowledged = await store.transact(owner, async tx => {
            const existing = await tx.read("publication", accepted.operationId);
            if (existing !== undefined) {
              const retained = await verifiedPaPublication(existing);
              return canonicalJson(retained.prepared) === canonicalJson(accepted);
            }
            const attempt = await tx.read("attempt", accepted.operationId);
            if (attempt !== undefined) {
              return canonicalJson(attempt) === canonicalJson({grantRequestId: accepted.grantRequestId, requestDigest: accepted.requestDigest});
            }
            // Requests and operations both have immutable identities, including negative outcomes.
            if (await tx.read("grant", accepted.grantRequestId) !== undefined) {return false;}
            const retained = await tx.read("issuance", issuance.issuanceRef);
            if (canonicalJson(retained) !== canonicalJson(issuance)) {throw new Error("PA issuance was not independently provisioned");}
            assertPaCurrentMaterialization(tx, issuance);
            if (tx.controlTime < issuance.validFromControlTime || tx.controlTime >= issuance.claimBeforeControlTime ||
              tx.controlTime >= issuance.expiresAtControlTime) {throw new Error("PA issuance outside fixed window");}
            await tx.insert("publication", accepted.operationId, await paPublication(accepted, issuance));
            return true;
          });
          if (!acknowledged) {return conflict();}
          // A separate transaction starts only after publication COMMIT acknowledgement.
          return await consumeForDispatch(command);
        } catch {return Object.freeze({kind: "indeterminate"});}
      },
      async observeDispatchConsumption(input: ObserveDispatchConsumptionInput): Promise<ConsumeForDispatchOutcome> {
        let command;
        try {command = observeInputFromContract(input);}
        catch {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
        return feature("database:observation").observeDispatchConsumption(command);
      },
      async settleDispatchConsumption(input: SettleDispatchConsumptionInput): Promise<SettleDispatchConsumptionOutcome> {
        let command;
        try {command = settlementInputFromContract(input);}
        catch {return Object.freeze({kind: "invalid", reason: "invalid_request"});}
        return feature(command.operationId).settleDispatchConsumption(command);
      },
    }),
    control: Object.freeze({
      async provisionIssuance(): Promise<void> {
        await store.transact(owner, async tx => {
          const existing = await tx.read("issuance", issuance.issuanceRef);
          if (existing !== undefined) {
            if (canonicalJson(existing) !== canonicalJson(issuance)) {throw new Error("PA issuance identity cannot be rebound");}
            return;
          }
          assertPaCurrentMaterialization(tx, issuance);
          await tx.insert("issuance", issuance.issuanceRef, issuance);
        });
      },
    }),
  });
};
