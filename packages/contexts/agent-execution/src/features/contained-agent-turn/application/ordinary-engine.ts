import {ORDINARY_PROFILE, type OrdinaryOperation, type OrdinaryReceipt, type OrdinaryOperationRef, type OrdinaryView, type OrdinaryInput} from "../domain/ordinary-model.js";
import {validateOrdinaryInput, validateOrdinaryOperation, validateOrdinaryReceipt} from "../domain/ordinary-validation.js";
import type {OrdinaryCredentialMaterial, OrdinaryTurnDependencies, OrdinaryProviderGrant, OrdinarySecurityGrant, OrdinaryWorkspaceHandle, OrdinaryProcessReservation} from "./ordinary-ports.js";

const reference = (operation: OrdinaryOperation): OrdinaryOperationRef => ({operationId: operation.operationId, scope: {tenantId: operation.scope.tenantId, projectId: operation.scope.projectId}});
const view = (operation: OrdinaryOperation): OrdinaryView => {
  validateOrdinaryOperation(operation);
  const artifact = operation.receipts.find(item => item.kind === "artifact_published");
  return {commandId: operation.commandId, operationId: operation.operationId, effectId: operation.effectId, provider: operation.input.expectedProvider, revision: operation.revision, status: operation.status, output: operation.output.map(item => ({cursor: item.cursor, kind: item.kind, text: item.text})), ...ORDINARY_PROFILE, ...(artifact === undefined ? {} : {artifactManifestRef: artifact.artifactManifestRef, resultRef: artifact.resultRef})};
};
interface Flight {readonly operation: OrdinaryOperation; readonly controller: AbortController; readonly completion: Promise<void>; cleanup?: () => Promise<void>}
export interface OrdinarySubmitOptions {readonly signal?: AbortSignal; readonly onAccepted?: (operation: OrdinaryOperationRef) => void}
export type OrdinarySubmitOutcome =
  | {readonly status: "denied"}
  | {readonly status: "potential_acceptance"; readonly commandId: string; readonly candidateOperationId: string; readonly evidenceId: string}
  | {readonly status: "conflict"; readonly code: "command_fingerprint_conflict"}
  | {readonly status: "unsupported"; readonly code: "provider_mismatch" | "mode_unsupported"}
  | {readonly status: "observed"; readonly turn: OrdinaryView};
export type OrdinaryObserveOutcome = {readonly status: "not_found"} | {readonly status: "observed"; readonly turn: OrdinaryView};
export interface OrdinaryFeature {
  readonly submit: {execute(input: OrdinaryInput, options?: OrdinarySubmitOptions): Promise<OrdinarySubmitOutcome>};
  readonly observe: {execute(input: OrdinaryOperationRef): Promise<OrdinaryObserveOutcome>};
  readonly cancel: {execute(input: OrdinaryOperationRef): Promise<OrdinaryObserveOutcome>};
  dispose(): Promise<void>;
}
const validateAuthorityDeadline = (security: OrdinarySecurityGrant, provider: OrdinaryProviderGrant): number => {
  const now = Date.now(); const expiresAt = Math.min(security.expiresAt, provider.expiresAt);
  if (expiresAt <= now + 10000 || provider.expiresAt > now + 60000 || security.expiresAt > now + 60000 || provider.authority.expiresAt !== provider.expiresAt || security.authority.expiresAt !== security.expiresAt) {throw new Error("ordinary authority deadline invalid");}
  return expiresAt;
};
const canSnapshot = (launched: boolean, receipts: readonly OrdinaryReceipt[]): boolean =>
  launched && receipts.some(item => item.kind === "process_group_closed") && receipts.some(item => item.kind === "output_drain");
const recoverTerminalCommit = async (store: OrdinaryTurnDependencies["operationStore"], operation: OrdinaryOperation, receipts: OrdinaryReceipt[]): Promise<OrdinaryOperation> => {
  // A confirmed readback may reveal terminal success. It never authorizes a retry or new launch.
  const current = await store.read(reference(operation));
  if (current === undefined) {throw new Error("ordinary terminal commit unresolved", {cause: "missing terminal readback"});}
  if (["succeeded", "failed", "cancelled", "reconcile_required"].includes(current.status)) {return current;}
  try {return await store.reconcile(current, receipts.filter(receipt => receipt.kind !== "output_drain" || receipt.finalSequence === current.output.length));} catch (cause) {throw new Error("ordinary terminal commit unresolved", {cause});}
};
const executeOrdinaryOperation = async (dependencies: OrdinaryTurnDependencies, initial: OrdinaryOperation, controller: AbortController, flight: Flight): Promise<OrdinaryOperation> => {
  let operation = initial;
  let security: OrdinarySecurityGrant | undefined; let provider: OrdinaryProviderGrant | undefined;
  let workspace: OrdinaryWorkspaceHandle | undefined; let reservation: OrdinaryProcessReservation | undefined;
  let disposition: "claim_committed" | "abandoned_without_claim" | undefined = "abandoned_without_claim";
  let uncertainty = false; let launched = false; let dispatchAttempted = false;
  const unfinished = new Set<() => Promise<void>>();
  const receipts: OrdinaryReceipt[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const retain = (receipt: OrdinaryReceipt): void => {validateOrdinaryReceipt(receipt, operation); receipts.push(receipt);};
  const observeCancellation = async (): Promise<void> => {
    const current = await dependencies.operationStore.read(reference(operation));
    if (current === undefined) {throw new Error("ordinary operation disappeared");}
    operation = current;
    if (operation.cancellationRequested) {controller.abort();}
    controller.signal.throwIfAborted();
  };
  try {
    await observeCancellation();
    try {security = await dependencies.security.resolveAndConsume(operation, controller.signal);}
    catch (error) {uncertainty = true; throw error;}
    await observeCancellation();
    try {provider = await dependencies.providerAccess.resolveAndConsume(operation, controller.signal);}
    catch (error) {uncertainty = true; throw error;}
    const expiresAt = validateAuthorityDeadline(security, provider);
    timers.push(setTimeout(() => controller.abort(), Math.max(1, expiresAt - Date.now() - 10000)));
    await observeCancellation();
    // A rejected preparation may retain an allocated workspace, even on cancellation.
    try {workspace = await dependencies.workspace.prepare(operation, controller.signal);}
    catch (error) {uncertainty = true; throw error;}
    const materializeController = new AbortController();
    const materializeTimeout = setTimeout(() => materializeController.abort(), Math.min(15000, expiresAt - Date.now() - 10000));
    let credential: OrdinaryCredentialMaterial;
    try {credential = await provider.materialize(workspace, AbortSignal.any([controller.signal, materializeController.signal]));}
    finally {clearTimeout(materializeTimeout);}
    await observeCancellation();
    const monotonicNow = performance.now();
    const deadline = monotonicNow + Math.min(45000, expiresAt - Date.now() - 10000);
    if (deadline <= monotonicNow) {throw new Error("ordinary turn budget exhausted");}
    reservation = await dependencies.process.reserve({binding: {operationId: operation.operationId, attemptId: operation.attemptId, executionProfile: operation.executionProfile, capabilityManifestRevision: operation.capabilityManifestRevision}, workspace, credential, deadline});
    await observeCancellation();
    operation = await dependencies.operationStore.prepare(operation, {providerAccess: provider.authority, security: security.authority, workspaceId: workspace.workspaceId, reservationId: reservation.reservationId, materializationId: credential.materializationId, credentialGeneration: credential.generation});
    controller.signal.throwIfAborted();
    const claim = await dependencies.operationStore.claim(operation);
    if (claim.kind !== "claimed") {
      uncertainty = claim.kind === "unknown";
      if (uncertainty) {disposition = undefined;}
      const current = await dependencies.operationStore.read(reference(operation));
      if (current !== undefined) {
        operation = current;
        if (current.cancellationRequested) {controller.abort();}
        disposition = current.receipts.some(item => item.kind === "dispatch_claim") ? "claim_committed" : "abandoned_without_claim";
      }
      throw new Error("ordinary dispatch not owned");
    }
    disposition = "claim_committed"; operation = claim.operation; retain(claim.receipt);
    controller.signal.throwIfAborted();
    await observeCancellation();
    dispatchAttempted = true;
    const transport = await reservation.start(claim.receipt, controller.signal);
    launched = true;
    controller.signal.throwIfAborted();
    let polling: Promise<void> | undefined;
    const poll = setInterval(() => {
      if (polling !== undefined) {return;}
      polling = dependencies.operationStore.read(reference(operation)).then(current => {
        if (current === undefined) {uncertainty = true; controller.abort();}
        else if (current.cancellationRequested) {controller.abort();}
        return;
      }, () => {uncertainty = true; controller.abort();}).finally(() => {polling = undefined;});
    }, 250);
    try {
    const terminal = await dependencies.provider.execute({operation, transport, workspace, signal: controller.signal, deadline, emit: async output => {
      if (security === undefined || !await security.admitOutput(output)) {controller.abort(); throw new Error("ordinary output admission rejected");}
      operation = await dependencies.operationStore.append(operation, output);
    }});
    retain(terminal);
    } finally {clearInterval(poll); await polling;}
  } catch {uncertainty = uncertainty || dispatchAttempted || disposition === undefined || !controller.signal.aborted;}
  finally {for (const timer of timers) {clearTimeout(timer);}}
  const settleOwnedEffects = async (): Promise<void> => {
    flight.cleanup = async () => {
      const errors: unknown[] = [];
      for (const effect of unfinished) {try {await effect(); unfinished.delete(effect);} catch (error) {errors.push(error);}}
      try {await dependencies.operationStore.reconcile(operation, receipts);} catch (error) {errors.push(error);}
      if (errors.length > 0) {throw new AggregateError(errors, "ordinary cleanup incomplete", {cause: errors[0]});}
      delete flight.cleanup;
    };
    const cleanup = async (effect: () => Promise<void>, required = false): Promise<void> => {
      if (required) {unfinished.add(effect);}
      try {await effect(); unfinished.delete(effect);} catch {uncertainty = true;}
    };
    let sequenceConfirmed = false;
    if (reservation !== undefined) {
      const owned = reservation;
      const close = async (): Promise<void> => {
        const closed = await owned.close(operation.output.length);
        if ("kind" in closed) {
          if (launched || closed.kind !== "not_started" || closed.reservationId !== owned.reservationId) {throw new Error("ordinary closure mismatch");}
        } else {
          for (const receipt of closed) {validateOrdinaryReceipt(receipt, operation);}
          if (!closed.some(receipt => receipt.kind === "process_group_closed" && receipt.reservationId === owned.reservationId)) {throw new Error("ordinary termination unproven");}
          for (const receipt of closed) {if (receipt.kind !== "output_drain" || sequenceConfirmed) {retain(receipt);}}
        }
      };
      await cleanup(async () => {
        sequenceConfirmed = false;
        try {
          const current = await dependencies.operationStore.read(reference(operation));
          if (current === undefined || current.attemptId !== operation.attemptId) {throw new Error("ordinary output readback unresolved");}
          operation = current; sequenceConfirmed = true;
        } catch {uncertainty = true; /* Storage uncertainty must not prevent bounded physical cleanup. */ }
        await close();
      }, true);
    }
    if (workspace !== undefined && canSnapshot(launched, receipts)) {
      const owned = workspace;
      await cleanup(async () => {
        const snapshot = await dependencies.workspace.snapshot(operation, owned); retain(snapshot.receipt);
        if (security === undefined || !await security.admitArtifact(snapshot)) {throw new Error("ordinary artifact admission rejected");}
        retain(await dependencies.artifacts.publish(operation, snapshot));
      });
    }
    const settlementDisposition = async (): Promise<"claim_committed" | "abandoned_without_claim"> => {
      if (disposition === undefined) {
        const current = await dependencies.operationStore.read(reference(operation));
        if (current === undefined || current.attemptId !== operation.attemptId) {throw new Error("ordinary claim disposition unresolved");}
        disposition = current.receipts.some(receipt => receipt.kind === "dispatch_claim") ? "claim_committed" : "abandoned_without_claim";
      }
      return disposition;
    };
    if (provider !== undefined) {
      const owned = provider;
      await cleanup(async () => {retain(await owned.retire());}, true);
      await cleanup(async () => {retain(await owned.settle(await settlementDisposition()));}, true);
    }
    if (security !== undefined) {const owned = security; await cleanup(async () => {retain(await owned.settle(await settlementDisposition()));}, true);}
    // Temporary deletion follows truthful closure. Failure is retained as reconciliation, never hidden cleanup PASS.
    if (workspace !== undefined && !uncertainty) {const owned = workspace; await cleanup(async () => {await dependencies.workspace.close(owned);});}
  };
  await settleOwnedEffects();
  try {
    const result = await (uncertainty ? dependencies.operationStore.reconcile(operation, receipts) : dependencies.operationStore.finish(operation, receipts));
    if (unfinished.size === 0) {delete flight.cleanup;}
    return result;
  }
  catch {return recoverTerminalCommit(dependencies.operationStore, operation, receipts);}
};

const submitOwnedOperation = async (dependencies: OrdinaryTurnDependencies, operation: OrdinaryOperation, flights: Map<string, Flight>, isDisposed: () => boolean, options?: OrdinarySubmitOptions): Promise<OrdinarySubmitOutcome> => {
  const controller = new AbortController();
  let complete!: () => void;
  const completion = new Promise<void>(resolve => {complete = resolve;});
  const flight: Flight = {operation, controller, completion};
  flights.set(operation.operationId, flight);
  const signalCancellations: Promise<void>[] = [];
  const cancel = (): void => {
    const pending = dependencies.operationStore.cancel(reference(operation)).then(() => {controller.abort(); return;}, () => {controller.abort(); throw new Error("ordinary signal cancellation persistence unresolved");});
    signalCancellations.push(pending); void pending.catch(() => {});
  };
  options?.signal?.addEventListener("abort", cancel, {once: true});
  let result: OrdinarySubmitOutcome | undefined;
  let failure: {error: unknown} | undefined;
  let cancellationFailed = false;
  try {
    if (isDisposed() || options?.signal?.aborted) {await dependencies.operationStore.cancel(reference(operation)); controller.abort();}
    try {options?.onAccepted?.(reference(operation));} catch {await dependencies.operationStore.cancel(reference(operation)); controller.abort();}
    result = {status: "observed", turn: view(await executeOrdinaryOperation(dependencies, operation, controller, flight))};
  } catch (error) {failure = {error};} finally {
    options?.signal?.removeEventListener("abort", cancel);
    const cancellations = await Promise.allSettled(signalCancellations);
    if (flight.cleanup === undefined) {flights.delete(operation.operationId);} complete();
    cancellationFailed = cancellations.some(outcome => outcome.status === "rejected");
  }
  if (cancellationFailed) {throw new Error("ordinary signal cancellation persistence unresolved");}
  if (failure !== undefined) {throw failure.error;}
  if (result === undefined) {throw new Error("ordinary submission outcome unresolved");}
  return result;
};

/** Compact cooperative lifecycle. Every process launch is dominated by an acknowledged durable claim. */
export const createOrdinaryEngine = (dependencies: OrdinaryTurnDependencies): OrdinaryFeature => {
  const flights = new Map<string, Flight>();
  const submissions = new Set<Promise<OrdinarySubmitOutcome>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const submitAccepted = async (input: OrdinaryInput, options?: OrdinarySubmitOptions): Promise<OrdinarySubmitOutcome> => {
    if (disposed) {return {status: "denied"};}
    if (input.expectedProvider !== dependencies.provider.supported.provider) {return {status: "unsupported", code: "provider_mismatch"};}
    if (input.intent.mode !== dependencies.provider.supported.mode) {return {status: "unsupported", code: "mode_unsupported"};}
    validateOrdinaryInput(input);
    const accepted = await dependencies.operationStore.accept(input);
    if (accepted.kind === "conflict") {return {status: "conflict", code: "command_fingerprint_conflict"};}
    if (accepted.kind === "unknown") {return {status: "potential_acceptance", commandId: input.commandId, candidateOperationId: accepted.candidateOperationId, evidenceId: accepted.evidenceId};}
    if (accepted.kind === "duplicate") {try {options?.onAccepted?.(reference(accepted.operation));} catch { /* observer callback cannot acquire dispatch ownership */ } return {status: "observed", turn: view(accepted.operation)};}
    return submitOwnedOperation(dependencies, accepted.operation, flights, () => disposed, options);
  };

  const submit = (input: OrdinaryInput, options?: OrdinarySubmitOptions): Promise<OrdinarySubmitOutcome> => {
    const pending = submitAccepted(input, options); submissions.add(pending);
    void pending.then(() => {submissions.delete(pending); return;}, () => {submissions.delete(pending);});
    return pending;
  };
  const localFlight = (input: OrdinaryOperationRef): Flight | undefined => {
    const flight = flights.get(input.operationId);
    return flight?.operation.scope.tenantId === input.scope.tenantId && flight.operation.scope.projectId === input.scope.projectId ? flight : undefined;
  };
  return {
    submit: {execute: submit},
    observe: {execute: async input => {const operation = await dependencies.operationStore.read(input); return operation === undefined ? {status: "not_found"} : {status: "observed", turn: view(operation)};}},
    cancel: {execute: async input => {
      let operation: OrdinaryOperation | undefined;
      try {operation = await dependencies.operationStore.cancel(input);} catch (error) {localFlight(input)?.controller.abort(); throw error;}
      if (operation === undefined) {return {status: "not_found"};}
      localFlight(input)?.controller.abort(); return {status: "observed", turn: view(operation)};
    }},
    dispose: () => disposal ??= (async () => {
      disposed = true;
      const acceptedOrPending = [...submissions];
      const owned = [...flights.values()];
      const cancelled = await Promise.allSettled(owned.map(async flight => {try {await dependencies.operationStore.cancel(reference(flight.operation));} finally {flight.controller.abort();}}));
      await Promise.all(owned.map(flight => flight.completion));
      const completed = await Promise.allSettled(acceptedOrPending);
      const cleaned = await Promise.allSettled([...flights.entries()].map(async ([id, flight]) => {
        await flight.cleanup?.(); flights.delete(id);
      }));
      const errors = [...cancelled, ...completed, ...cleaned].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) {throw new AggregateError(errors, "ordinary disposal incomplete", {cause: errors[0]});}
    })().catch(error => {disposal = undefined; throw error;}),
  };
};
