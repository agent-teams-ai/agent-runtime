import type {DriverObservation, InteractionAnswer, InteractiveSessionDependencies} from "../ports/outbound/interactive-session-ports.js";
import type {Event, Session} from "../ports/outbound/interactive-provider-driver.js";
import {command, mutateSession, priorCommand} from "./session-mutation.js";
import {normalizeProviderEvent} from "./normalize-provider-event.js";
import {answerFingerprint, interactionAnswer} from "./interaction-answer.js";
import {sameScope, sessionView, terminal, utf8Bytes, validateRecord, type JsonValue, type SessionRecord,
  type SessionRef, type SessionReply, type SessionView} from "../../domain/session.js";

const accepted = (): SessionReply => ({status: "accepted"});
// Receipts cross runtime boundaries; truthy malformed values never prove closure.
const confirmedTrue = (value: unknown): value is true => value === true;
const staleTarget = (record: SessionRecord, observation: DriverObservation): boolean => {
  if (observation.operationId === undefined) {return false;}
  const input = record.inputs.find(item => item.operationId === observation.operationId);
  return !input || terminal(input.status) || input.inputId !== observation.inputId || input.delivery === "admitted";
};
const active = (record: SessionRecord): boolean => record.inputs.some(input => ["dispatching", "client_consumed", "reconcile_required"].includes(input.status));
const key = (ref: SessionRef): string => JSON.stringify([ref.tenantId, ref.projectId, ref.sessionId, ref.generation]);
const validId = (value: string): boolean => typeof value === "string" && /^[A-Za-z0-9:._-]{1,128}$/u.test(value);

/** Scoped technical owner; business task/team state belongs to its consumer. */
export class InteractiveSessionOwner {
  readonly #deps: InteractiveSessionDependencies;
  readonly #drivers = new Map<string, Session>();
  readonly #iterators = new Map<string, AsyncIterator<Event>>();
  readonly #observing = new Set<string>();
  readonly #closes = new Map<string, Promise<SessionReply>>();
  readonly #ownerCloses = new Map<string, Promise<SessionReply>>();
  readonly #sealed = new Set<string>();
  readonly #gates = new Map<string, Promise<void>>();
  readonly #logicallyClosed = new Set<string>();
  constructor(dependencies: InteractiveSessionDependencies) {this.#deps = dependencies;}

  /** Serializes durable effect admission and invocation, never waits for a provider turn/control result. */
  async #admitEffect<T>(ref: SessionRef, action: () => Promise<T>): Promise<T> {
    const id = key(ref); const previous = this.#gates.get(id) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>(resolve => {release = resolve;});
    this.#gates.set(id, done);
    await previous;
    try {return await action();} finally {release(); if (this.#gates.get(id) === done) {this.#gates.delete(id);}}
  }
  #runEffect<T>(phase: "handoff" | "observe" | "control" | "close", work: () => Promise<T>): Promise<T> {
    try {const running = work(); void running.catch(() => {}); return this.#deps.withinDeadline(phase, () => running);} catch (error) {return Promise.reject(error);}
  }

  async open(ref: SessionRef, commandId: string, configRevision: string, requiredCapabilities: readonly string[]): Promise<SessionReply> {
    if (!sameScope(ref, this.#deps.scope) || !await this.#deps.authorize("open", ref)) {return {status: "denied"};}
    if (![ref.sessionId, commandId].every(validId) || ref.generation !== 1 || !configRevision) {return {status: "unsupported"};}
    const fingerprint = JSON.stringify(["open", configRevision, requiredCapabilities.toSorted()]);
    const record: SessionRecord = {schemaVersion: 1, ...ref, revision: 0, configRevision,
      requiredCapabilities: [...requiredCapabilities], status: "opening", controlPending: false,
      limits: {...this.#deps.limits}, inputs: [], interactions: [], events: [],
      commands: [{commandId, fingerprint, disposition: "accepted"}]};
    validateRecord(record);
    const created = await this.#deps.store.create(record);
    if (created === "unknown") {return {status: "unknown"};}
    if (created === "conflict") {
      const previous = await this.#deps.store.read(ref);
      return previous?.generation === ref.generation ? priorCommand(previous, commandId, fingerprint) ?? {status: "conflict"} : {status: "stale"};
    }
    return this.#connect(record);
  }

  async #connect(record: SessionRecord): Promise<SessionReply> {
    try {
      const admitted = await this.#admitEffect(record, async () => {
        const current = await this.#deps.store.read(record);
        if (this.#sealed.has(key(record)) || current?.generation !== record.generation || current.status !== "opening") {return;}
        // Retain even a late factory result: a timeout never transfers cleanup ownership away.
        const opening = this.#deps.drivers.open({tenantId: record.tenantId,
          projectId: record.projectId, sessionId: record.sessionId, generation: record.generation,
          requiredCapabilities: record.requiredCapabilities, configRevision: record.configRevision,
          ...(record.checkpointRef === undefined ? {} : {checkpointRef: record.checkpointRef})}).then(async opened => {
          this.#drivers.set(key(record), opened.driver);
          if (this.#sealed.has(key(record))) {
            // If earlier cleanup captured no handle, finish it before taking custody of this late handle.
            const previous = this.#ownerCloses.get(key(record)); if (previous) {await previous;}
            await this.#cleanup(record);
          }
          return opened;
        });
        return {pending: this.#runEffect("handoff", () => opening)};
      });
      if (!admitted) {return {status: "unavailable"};}
      const opened = await admitted.pending;
      if (this.#sealed.has(key(record))) {await this.#cleanup(record); return {status: "unavailable"};}
      if (record.requiredCapabilities.some(capability => !opened.capabilities.includes(capability))) {
        await this.#cleanup(record);
        return {status: "unsupported"};
      }
      const readinessAdmission = await this.#admitEffect(record, async () => {
        const current = await this.#deps.store.read(record);
        if (this.#sealed.has(key(record)) || current?.generation !== record.generation || current.status !== "opening") {return;}
        return {pending: this.#runEffect("handoff", () => opened.driver.checkReadiness())};
      });
      if (!readinessAdmission) {await this.#cleanup(record); return {status: "unavailable"};}
      const readiness = await readinessAdmission.pending;
      if (!readiness.ok) {await this.#cleanup(record); return {status: "unavailable"};}
      const ready = await mutateSession(this.#deps, record, current => current.status === "opening"
        ? {record: {...current, status: "ready"}, reply: accepted()} : {status: "unavailable"});
      if (ready.reply.status !== "accepted") {await this.#cleanup(record);}
      return ready.reply;
    } catch {
      // Construction can have acquired resources. No retry and no inferred physical closure.
      await mutateSession(this.#deps, record, current => ["closed", "closing"].includes(current.status) ? {status: "unknown"} :
        {record: {...current, status: "reconcile_required"}, reply: {status: "unknown"}});
      await this.#cleanup(record);
      return {status: "unknown"};
    }
  }

  async read(ref: SessionRef): Promise<SessionView | undefined> {
    if (!sameScope(ref, this.#deps.scope)) {return;}
    const record = await this.#deps.store.read(ref);
    return record?.generation === ref.generation ? sessionView(record) : undefined;
  }

  async submit(ref: SessionRef, input: {readonly commandId: string; readonly inputId: string; readonly content: string}): Promise<SessionReply> {
    if (this.#sealed.has(key(ref))) {return {status: "unavailable"};}
    if (!await this.#deps.authorize("submit", ref)) {return {status: "denied"};}
    if (![input.commandId, input.inputId].every(validId) || typeof input.content !== "string") {return {status: "unsupported"};}
    const operationId = this.#deps.newOperationId();
    if (!validId(operationId)) {throw new TypeError("interactive_operation_identity_invalid");}
    const fingerprint = JSON.stringify(["submit", input.inputId, input.content]);
    const result = await this.#admitEffect(ref, async () => {
      if (this.#sealed.has(key(ref))) {return {reply: {status: "unavailable"} satisfies SessionReply};}
      return mutateSession(this.#deps, ref, current => {
      const prior = priorCommand(current, input.commandId, fingerprint); if (prior) {return prior;}
      if (current.status !== "ready") {return {status: "unavailable"};}
      if (current.inputs.some(item => item.inputId === input.inputId || item.operationId === operationId)) {return {status: "conflict"};}
      if (current.inputs.filter(item => !terminal(item.status)).length >= current.limits.queuedInputs || utf8Bytes(input.content) > current.limits.inputBytes) {return {status: "backpressure"};}
      return {record: {...command(current, input.commandId, fingerprint), inputs: [...current.inputs,
        {inputId: input.inputId, operationId, content: input.content, status: "admitted", delivery: "admitted", cancellationRequested: false}]}, reply: accepted()};
      });
    });
    const persisted = result.record?.inputs.find(item => item.inputId === input.inputId);
    return persisted && ["accepted", "duplicate"].includes(result.reply.status)
      ? {...result.reply, receipt: {inputId: persisted.inputId, operationId: persisted.operationId}} : result.reply;
  }

  /** Host invokes this bounded pump; it claims exactly one input and never retries an effect. */
  async dispatch(ref: SessionRef): Promise<SessionReply> {
    if (this.#sealed.has(key(ref))) {return {status: "unavailable"};}
    if (!await this.#deps.authorize("dispatch", ref)) {return {status: "denied"};}
    const admission = await this.#admitEffect(ref, async () => {
      const driver = this.#drivers.get(key(ref));
      if (this.#sealed.has(key(ref)) || !driver) {return {reply: {status: "unavailable"} satisfies SessionReply};}
      let operationId: string | undefined;
      const claimed = await mutateSession(this.#deps, ref, current => {
        if (current.status !== "ready" || current.controlPending || active(current)) {return {status: "unavailable"};}
        const input = current.inputs.find(item => item.status === "admitted"); if (!input) {return {status: "unavailable"};}
        operationId = input.operationId;
        return {record: {...current, inputs: current.inputs.map(item => item.operationId === operationId
          ? {...item, status: "dispatching", delivery: "dispatching"} : item)}, reply: accepted()};
      });
      if (claimed.reply.status !== "accepted" || !claimed.record || operationId === undefined || operationId.length === 0) {return {reply: claimed.reply};}
      const input = claimed.record.inputs.find(item => item.operationId === operationId)!;
      const pending = this.#runEffect("handoff", () => driver.submit({inputId: input.inputId, operationRef: input.operationId, content: input.content}));
      return {reply: claimed.reply, operationId, inputId: input.inputId, pending};
    });
    if (!admission.pending || !admission.operationId) {return admission.reply;}
    const operationId = admission.operationId;
    let disposition: "client_consumed" | "known_not_sent" | "unknown" = "unknown";
    try {
      const handoff = await admission.pending;
      const evidence: {readonly delivery: unknown; readonly providerAcceptance: unknown} | undefined = handoff.ok ? handoff.value : undefined;
      disposition = handoff.ok ? handoff.value.operationRef === operationId && handoff.value.inputId === admission.inputId &&
        evidence?.delivery === "client-consumed" && evidence.providerAcceptance === "unknown" ? "client_consumed" : "unknown"
        : handoff.delivery === "known-not-sent" ? "known_not_sent" : "unknown";
    } catch { /* Acceptance is unknown. */ }
    return (await mutateSession(this.#deps, ref, current => {
      const latest = current.inputs.find(item => item.operationId === operationId);
      if (["closing", "closed", "reconcile_required"].includes(current.status)) {return {status: "unknown"};}
      if (!latest || terminal(latest.status)) {return accepted();}
      return {record: {...current, status: disposition === "unknown" ? "reconcile_required" : current.status,
        inputs: current.inputs.map(item => item.operationId === operationId ? {...item, delivery: disposition,
          status: disposition === "unknown" ? "reconcile_required" : disposition === "known_not_sent" ? item.cancellationRequested ? "cancelled" : "admitted" : "client_consumed"} : item)}, reply: {status: disposition === "unknown" ? "unknown" : "accepted"}};
    })).reply;
  }

  /** One bounded provider-output step, independent of prompt handoff and control. Host schedules it. */
  async pumpOutput(ref: SessionRef): Promise<SessionReply> {
    const driver = this.#drivers.get(key(ref));
    if (!sameScope(ref, this.#deps.scope) || !driver || this.#sealed.has(key(ref)) || this.#observing.has(key(ref))) {return {status: "unavailable"};}
    this.#observing.add(key(ref));
    try {
      const current = await this.read(ref);
      if (current?.status !== "ready" || this.#sealed.has(key(ref))) {return {status: "unavailable"};}
      let iterator = this.#iterators.get(key(ref));
      if (!iterator) {iterator = driver.observe()[Symbol.asyncIterator](); this.#iterators.set(key(ref), iterator);}
      const observation = await this.#runEffect("observe", () => iterator.next());
      if (observation.done === true) {
        await this.record(ref, {kind: "diagnostic", data: {code: "iterator-ended"}});
        return this.recover(ref);
      }
      if (observation.value.sessionRef !== driver.sessionRef) {return this.recover(ref);}
      return await this.record(ref, normalizeProviderEvent(observation.value, this.#deps.clock.now() + this.#deps.interactionTimeoutMs));
    } catch {return this.recover(ref);} finally {this.#observing.delete(key(ref));}
  }

  async record(ref: SessionRef, observation: DriverObservation): Promise<SessionReply> {
    return (await mutateSession(this.#deps, ref, current => {
      if (!["ready", "unavailable"].includes(current.status)) {return {status: "unavailable"};}
      const target = observation.operationId === undefined ? undefined : current.inputs.find(input => input.operationId === observation.operationId);
      if (staleTarget(current, observation)) {return {status: "stale"};}
      if (current.events.length >= current.limits.events || utf8Bytes(JSON.stringify(observation)) > current.limits.eventBytes) {
        return {record: {...current, status: "reconcile_required", events: [...current.events, {
          sequence: current.events.length + 1, generation: ref.generation, kind: "diagnostic", data: {code: "output-limit"},
        }]}, reply: {status: "backpressure"}};
      }
      let next = current;
      if (observation.kind === "result") {
        next = {...next, status: observation.outcome === "unknown" ? "reconcile_required" : next.status,
          inputs: next.inputs.map(input => input.operationId === observation.operationId ? {...input,
            status: observation.outcome === "unknown" ? "reconcile_required" : observation.outcome} : input),
          interactions: next.interactions.map(interaction => interaction.operationId === observation.operationId && ["pending", "replying"].includes(interaction.state) ? {...interaction, state: "cancelled"} : interaction)};
      }
      if (observation.kind === "interaction") {
        if (target?.cancellationRequested === true) {return {status: "stale"};}
        if (next.interactions.some(item => item.generation === ref.generation && item.interactionId === observation.interactionId) || observation.expiresAt <= this.#deps.clock.now()) {return {status: "stale"};}
        if (next.interactions.filter(item => ["pending", "replying"].includes(item.state)).length >= next.limits.interactions) {return {status: "backpressure"};}
        next = {...next, interactions: [...next.interactions, {interactionId: observation.interactionId, generation: ref.generation,
          ...(observation.operationId === undefined ? {} : {operationId: observation.operationId}), kind: observation.requestKind, expiresAt: observation.expiresAt, state: "pending"}]};
      }
      const data: JsonValue = observation.kind === "result" ? {outcome: observation.outcome} : observation.kind === "interaction"
        ? {interactionId: observation.interactionId, kind: observation.requestKind, expiresAt: observation.expiresAt, ...(observation.data === undefined ? {} : {request: observation.data})} : observation.data;
      return {record: {...next, events: [...next.events, {sequence: next.events.length + 1, generation: ref.generation,
        ...(observation.operationId === undefined ? {} : {operationId: observation.operationId}),
        ...(observation.inputId === undefined ? {} : {inputId: observation.inputId}), kind: observation.kind, data}]}, reply: accepted()};
    })).reply;
  }

  async reply(ref: SessionRef, commandId: string, interactionId: string, answer: InteractionAnswer): Promise<SessionReply> {
    if (!await this.#deps.authorize("reply", ref)) {return {status: "denied"};}
    const validated = interactionAnswer(answer);
    if (!validId(commandId) || !validId(interactionId) || !validated) {return {status: "unsupported"};}
    const fingerprint = answerFingerprint(interactionId, validated);
    if (utf8Bytes(fingerprint) > this.#deps.limits.inputBytes) {return {status: "backpressure"};}
    const admitted = await this.#admitEffect(ref, async () => {
      const driver = this.#drivers.get(key(ref)); if (this.#sealed.has(key(ref)) || !driver) {return {reply: {status: "unavailable"} satisfies SessionReply};}
      const claimed = await mutateSession(this.#deps, ref, current => {
        const prior = priorCommand(current, commandId, fingerprint); if (prior) {return prior;}
        const request = current.interactions.find(item => item.generation === ref.generation && item.interactionId === interactionId);
        const operation = request?.operationId === undefined ? undefined : current.inputs.find(item => item.operationId === request.operationId);
        if (current.status !== "ready" || !request || request.state !== "pending" || request.kind !== validated.kind || request.expiresAt <= this.#deps.clock.now() ||
          operation !== undefined && (operation.cancellationRequested || terminal(operation.status))) {return {status: "stale"};}
        return {record: {...command(current, commandId, fingerprint), interactions: current.interactions.map(item => item === request ? {...item, state: "replying"} : item)}, reply: accepted()};
      });
      return claimed.reply.status === "accepted" ? {reply: claimed.reply, pending: this.#runEffect("control", async () => driver.respondToInteraction(interactionId, validated))} : {reply: claimed.reply};
    });
    if (!admitted.pending) {return admitted.reply;}
    let outcome: "applied" | "stale" | "unknown" = "unknown";
    try {const reply = await admitted.pending; outcome = reply.ok ? "applied" : reply.code === "stale" ? "stale" : "unknown";} catch { /* No replay of uncertain answers. */ }
    return (await mutateSession(this.#deps, ref, current => {
      const request = current.interactions.find(item => item.generation === ref.generation && item.interactionId === interactionId);
      if (current.status !== "ready" || request?.state !== "replying") {return {status: "stale"};}
      return {record: {...current,
      status: outcome === "unknown" ? "reconcile_required" : current.status,
      commands: current.commands.map(item => item.commandId === commandId ? {...item, disposition: outcome === "unknown" ? "unknown" : "complete"} : item),
      interactions: current.interactions.map(item => item.generation === ref.generation && item.interactionId === interactionId ? {...item, state: outcome === "applied" ? "replied" : outcome === "stale" ? "cancelled" : "unknown"} : item)}, reply: {status: outcome === "applied" ? "accepted" : outcome}};
    })).reply;
  }

  async interrupt(ref: SessionRef, commandId: string, operationId: string): Promise<SessionReply> {
    if (!await this.#deps.authorize("interrupt", ref)) {return {status: "denied"};}
    const fingerprint = JSON.stringify(["interrupt", operationId]);
    const admitted = await this.#admitEffect(ref, async () => {
      if (this.#sealed.has(key(ref))) {return {reply: {status: "unavailable"} satisfies SessionReply};}
      const claimed = await mutateSession(this.#deps, ref, current => {
        const prior = priorCommand(current, commandId, fingerprint); if (prior) {return prior;}
        const input = current.inputs.find(item => item.operationId === operationId);
        if (current.status !== "ready" || current.controlPending || !input || terminal(input.status)) {return {status: "stale"};}
        const queued = input.status === "admitted";
        return {record: {...command(current, commandId, fingerprint), controlPending: !queued,
          inputs: current.inputs.map(item => item === input ? {...item, cancellationRequested: true, status: queued ? "cancelled" : item.status} : item),
          interactions: current.interactions.map(item => item.operationId === operationId && ["pending", "replying"].includes(item.state) ? {...item, state: "cancelled"} : item)}, reply: accepted()};
      });
      if (claimed.reply.status !== "accepted" || claimed.record?.controlPending !== true) {return {reply: claimed.reply};}
      const driver = this.#drivers.get(key(ref));
      return {reply: claimed.reply, pending: driver ? this.#runEffect("control", () => driver.interrupt(operationId)) : Promise.resolve({ok: false as const, code: "unknown" as const})};
    });
    if (!admitted.pending) {return admitted.reply;}
    let outcome: "requested" | "stale" | "unknown" = "unknown";
    try {const reply = await admitted.pending; outcome = reply.ok ? "requested" : reply.code === "stale" ? "stale" : "unknown";} catch { /* Unknown control keeps later inputs fenced. */ }
    return (await mutateSession(this.#deps, ref, current => {
      if (["closing", "closed", "reconcile_required"].includes(current.status)) {return {status: "stale"};}
      return {record: {...current,
      controlPending: outcome === "unknown", status: outcome === "unknown" ? "reconcile_required" : current.status,
      commands: current.commands.map(item => item.commandId === commandId ? {...item, disposition: outcome === "unknown" ? "unknown" : "complete"} : item)}, reply: {status: outcome === "requested" ? "accepted" : outcome}};
    })).reply;
  }

  async recover(ref: SessionRef): Promise<SessionReply> {
    // Read/reconcile only: persisted running or opening state cannot recreate a provider process.
    return (await mutateSession(this.#deps, ref, current => current.status === "closed" ? accepted() :
      {record: {...current, status: "reconcile_required", inputs: current.inputs.map(input => terminal(input.status) ? input : {...input, status: "reconcile_required"}),
        interactions: current.interactions.map(item => item.state === "pending" || item.state === "replying" ? {...item, state: "unknown"} : item)}, reply: {status: "unknown"}})).reply;
  }

  close(ref: SessionRef): Promise<SessionReply> {
    const existing = this.#closes.get(key(ref)); if (existing) {return existing;}
    const closing = this.#close(ref).finally(() => {if (this.#closes.get(key(ref)) === closing) {this.#closes.delete(key(ref));}});
    this.#closes.set(key(ref), closing); return closing;
  }
  /** Trusted owner disposal; it cannot depend on a caller retaining close permission. */
  cleanup(ref: SessionRef): Promise<SessionReply> {return this.#cleanup(ref);}
  async #close(ref: SessionRef): Promise<SessionReply> {
    if (!await this.#deps.authorize("close", ref)) {return {status: "denied"};}
    return this.#cleanup(ref);
  }
  /** Owner teardown authority is independent of permission to request a public close. */
  #cleanup(ref: SessionRef): Promise<SessionReply> {
    const previous = this.#ownerCloses.get(key(ref)); if (previous) {return previous;}
    const closing = this.#performCleanup(ref).finally(() => {if (this.#ownerCloses.get(key(ref)) === closing) {this.#ownerCloses.delete(key(ref));}});
    this.#ownerCloses.set(key(ref), closing); return closing;
  }
  async #performCleanup(ref: SessionRef): Promise<SessionReply> {
    const admission = await this.#admitEffect(ref, async () => {
      const sealed = await mutateSession(this.#deps, ref, current => current.status === "closed" ? {status: "duplicate"} :
        {record: {...current, status: "closing", interactions: current.interactions.map(item => item.state === "pending" || item.state === "replying" ? {...item, state: "cancelled"} : item)}, reply: accepted()});
      if (sealed.reply.status === "duplicate") {
        const late = this.#drivers.get(key(ref));
        return {reply: sealed.reply, late: late ? this.#runEffect("close", () => late.close()) : undefined};
      }
      if (sealed.reply.status !== "accepted") {return {reply: sealed.reply};}
      this.#sealed.add(key(ref));
      const driver = this.#drivers.get(key(ref));
      return {reply: sealed.reply, pending: this.#logicallyClosed.has(key(ref)) ? undefined : driver ? this.#runEffect("close", () => driver.close()) : undefined};
    });
    if (admission.reply.status !== "accepted") {
      if (admission.late) {
        try {
          if (!confirmedTrue((await admission.late).logicallyClosed)) {return {status: "unknown"};}
          this.#drivers.delete(key(ref)); this.#iterators.delete(key(ref));
        } catch {return {status: "unknown"};}
      }
      return admission.reply;
    }
    let logicalClosed = this.#logicallyClosed.has(key(ref)); let outputDrained = false; let resourcesStopped = false;
    try {if (admission.pending) {const receipt = await admission.pending; logicalClosed = confirmedTrue(receipt.logicallyClosed);
      if (logicalClosed) {this.#logicallyClosed.add(key(ref));}}} catch { /* Custody still executes. */ }
    try {
      const proof = await this.#deps.withinDeadline("close", () => this.#deps.custody.close(ref));
      outputDrained = confirmedTrue(proof.outputDrained); resourcesStopped = confirmedTrue(proof.resourcesStopped);
      const ownerClosure = proof.ownerClosure;
      if (ownerClosure !== undefined && confirmedTrue(ownerClosure.logicalClosed) && confirmedTrue(ownerClosure.grantsClosed) && key(ownerClosure.session) === key(ref)) {
        logicalClosed = true; this.#logicallyClosed.add(key(ref));
      }
    } catch { /* Honest cleanup debt. */ }
    const closed = logicalClosed && outputDrained && resourcesStopped;
    const outcome = (await mutateSession(this.#deps, ref, current => ({record: {...current, status: closed ? "closed" : "reconcile_required", controlPending: closed ? false : current.controlPending,
      inputs: current.inputs.map(input => terminal(input.status) ? input : {...input, status: input.delivery === "admitted" ? "cancelled" : "reconcile_required"})}, reply: {status: closed ? "accepted" : "unknown"}}))).reply;
    if (closed && outcome.status === "accepted") {this.#drivers.delete(key(ref)); this.#iterators.delete(key(ref));}
    return outcome;
  }

  /** Checkpoint payload stays with its provider/private store; only the scoped reference is durable here. */
  async checkpoint(ref: SessionRef): Promise<SessionReply> {
    if (!sameScope(ref, this.#deps.scope) || !this.#deps.checkpoints) {return {status: "unsupported"};}
    return this.#admitEffect(ref, async () => {
      const driver = this.#drivers.get(key(ref)); const current = await this.#deps.store.read(ref);
      if (!driver || this.#sealed.has(key(ref)) || current?.generation !== ref.generation || current.status !== "ready" || active(current) || current.controlPending) {return {status: "unavailable"};}
      const checkpoint = driver.checkpoint(); if (!checkpoint.ok) {return {status: "unsupported"};}
      let checkpointRef: string;
      try {checkpointRef = await this.#runEffect("control", () => this.#deps.checkpoints!.save({...ref, configRevision: current.configRevision}, checkpoint.value));}
      catch {return {status: "unknown"};}
      if (!validId(checkpointRef)) {throw new TypeError("interactive_checkpoint_reference_invalid");}
      return (await mutateSession(this.#deps, ref, latest => latest.status === "ready" && !active(latest) && !latest.controlPending
        ? {record: {...latest, checkpointRef}, reply: accepted()} : {status: "unavailable"})).reply;
    });
  }

  async restore(ref: SessionRef, commandId: string, configRevision: string): Promise<SessionReply> {
    if (!await this.#deps.authorize("restore", ref)) {return {status: "denied"};}
    const fingerprint = JSON.stringify(["restore", configRevision]);
    const admitted = await mutateSession(this.#deps, ref, current => {
      const prior = priorCommand(current, commandId, fingerprint); if (prior) {return prior;}
      if (current.status !== "closed" || active(current) || current.controlPending || current.checkpointRef === undefined || current.checkpointRef.length === 0 || current.configRevision !== configRevision) {return {status: "unsupported"};}
      return {record: {...command(current, commandId, fingerprint), generation: current.generation + 1, status: "opening",
        interactions: current.interactions.map(item => item.state === "pending" || item.state === "replying" ? {...item, state: "cancelled"} : item)}, reply: accepted()};
    });
    return admitted.reply.status === "accepted" && admitted.record ? this.#connect(admitted.record) : admitted.reply;
  }
}
