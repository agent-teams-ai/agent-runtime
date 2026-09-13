import {isCodexRecord as isRecord, type CodexJsonRecord, BoundedCodexJsonLineReader, CODEX_APP_SERVER_TIMEOUT, decodeCodexResponseEnvelope} from "../codex-app-server/codex-app-server-jsonl.js";
import type {OrdinaryTransport} from "../../../application/ordinary-ports.js";
import {ordinaryCodexRefusal as refuse, ordinaryJson} from "./ordinary-codex-config.js";
import {type OrdinaryCodexItemRule, OrdinaryCodexItems} from "./ordinary-codex-items.js";

const exact = (value: CodexJsonRecord, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const isOrdinaryCodexId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export class OrdinaryCodexProtocol {
  readonly #transport: OrdinaryTransport;
  readonly #reader: BoundedCodexJsonLineReader;
  readonly #deadline: number;
  readonly #signal: AbortSignal;
  #bytes = 0; #messages = 0;
  public readonly pending: CodexJsonRecord[] = [];
  public constructor(transport: OrdinaryTransport, deadline: number, signal: AbortSignal) {
    this.#transport = transport; this.#deadline = deadline; this.#signal = signal;
    this.#reader = new BoundedCodexJsonLineReader({async *[Symbol.asyncIterator]() {
      for await (const line of transport.lines) {yield Buffer.from(`${line}\n`, "utf8");}
    }}, 262_144);
  }
  public async next(): Promise<CodexJsonRecord | undefined> {
    this.#signal.throwIfAborted();
    const value = await this.#reader.read(this.#deadline);
    if (value === CODEX_APP_SERVER_TIMEOUT) {return refuse();}
    if (value !== undefined) {
      this.#messages += 1; this.#bytes += Buffer.byteLength(JSON.stringify(value));
      if (this.#messages > 2048 || this.#bytes > 1_048_576) {refuse();}
    }
    return value;
  }
  public async notify(method: string): Promise<void> {await this.#transport.write(`${JSON.stringify({method})}\n`);}
  public async request(id: string, method: string, params: CodexJsonRecord): Promise<unknown> {
    this.#signal.throwIfAborted();
    await this.#transport.write(`${JSON.stringify({id, method, params})}\n`);
    for (;;) {
      const message = await this.next();
      if (message === undefined) {return refuse();}
      if ("id" in message) {
        const response = decodeCodexResponseEnvelope(message);
        if (response.id !== id || response.kind !== "result") {return refuse();}
        return response.result;
      }
      if (this.pending.length >= 256) {refuse();}
      this.pending.push(message);
    }
  }
}

export function ordinaryCodexTurn(value: unknown): CodexJsonRecord {
  if (!isRecord(value) || !exact(value, ["id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs"]) ||
      !isOrdinaryCodexId(value.id) || !Array.isArray(value.items) ||
      !["inProgress", "completed", "failed", "interrupted"].includes(String(value.status)) ||
      !["full", "summary", "notLoaded"].includes(String(value.itemsView)) ||
      [value.startedAt, value.completedAt, value.durationMs].some(field => field !== null && (!Number.isSafeInteger(field) || Number(field) < 0))) {return refuse();}
  validateTurnState(value);
  return value;
}

function validateTurnState(value: CodexJsonRecord): void {
  if (value.status === "inProgress") {
    if (value.completedAt !== null || value.durationMs !== null || value.error !== null) {refuse();}
  } else if (!Number.isSafeInteger(value.completedAt) || !Number.isSafeInteger(value.durationMs)) {refuse();}
  if (value.status === "failed") {
    if (!isRecord(value.error) || !exact(value.error, ["message", "codexErrorInfo", "additionalDetails", "misalignment"]) ||
        typeof value.error.message !== "string" || value.error.misalignment !== null ||
        value.error.additionalDetails !== null && typeof value.error.additionalDetails !== "string") {refuse();}
  } else if (value.error !== null) {refuse();}
}

export function ordinaryCodexNotification(message: CodexJsonRecord): {method: string; params: CodexJsonRecord} {
  if (!(exact(message, ["method", "params"]) || exact(message, ["method", "params", "emittedAtMs"]) && Number.isSafeInteger(message.emittedAtMs)) ||
      typeof message.method !== "string" || !isRecord(message.params)) {return refuse();}
  return {method: message.method, params: message.params};
}

export function admitOrdinaryStartup(message: CodexJsonRecord, threadId: string, seen: Set<string>): void {
  const {method, params} = ordinaryCodexNotification(message);
  if (seen.has(method)) {refuse();}
  seen.add(method);
  if (method === "remoteControl/status/changed" && params.status === "disabled" && params.environmentId === null) {return;}
  if (method === "thread/started" && exact(params, ["thread"]) && isRecord(params.thread) && params.thread.id === threadId) {return;}
  // Provider model remains pinned in thread/start and broker request admission. This warning concerns local metadata only.
  if (method === "warning" && exact(params, ["threadId", "message"]) && params.threadId === threadId &&
      params.message === "Model metadata for `gpt-5.3-codex-spark` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.") {return;}
  refuse();
}

const deltaKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "item/agentMessage/delta": ["delta", "itemId", "threadId", "turnId"],
  "item/commandExecution/outputDelta": ["delta", "itemId", "threadId", "turnId"],
  "item/fileChange/outputDelta": ["delta", "itemId", "threadId", "turnId"],
  "item/fileChange/patchUpdated": ["changes", "itemId", "threadId", "turnId"],
  "item/plan/delta": ["delta", "itemId", "threadId", "turnId"],
  "item/reasoning/summaryPartAdded": ["itemId", "summaryIndex", "threadId", "turnId"],
  "item/reasoning/summaryTextDelta": ["delta", "itemId", "summaryIndex", "threadId", "turnId"],
  "item/reasoning/textDelta": ["contentIndex", "delta", "itemId", "threadId", "turnId"],
});

export type OrdinaryCodexEventRule = OrdinaryCodexItemRule | "envelope" | "rate_limits" | "startup" | "scope" | "post_terminal" | "before_start" |
  "status" | "turn_start" | "delta_shape" | "item_delta" | "item_shape" | "item_start" | "item_complete" |
  "turn_complete_shape" | "turn_complete_state" | "terminal_items" | "passive";

/** No RPC request or unrecognized tool notification is treated as passive. */
export class OrdinaryCodexTurnEvents {
  readonly #threadId: string; readonly #turnId: string; readonly #items: OrdinaryCodexItems;
  readonly #startup: Set<string>;
  #validationRule: OrdinaryCodexEventRule = "envelope";
  #started = false;
  #systemError = false;
  #terminal: CodexJsonRecord | undefined;
  #assistant = "";
  public constructor(threadId: string, turnId: string, cwd: string, startup = new Set<string>()) {
    this.#threadId = threadId; this.#turnId = turnId; this.#items = new OrdinaryCodexItems(cwd, rule => {this.#validationRule = rule;});
    this.#startup = startup;
  }
  public get validationRule(): OrdinaryCodexEventRule {return this.#validationRule;}
  public get terminal(): CodexJsonRecord | undefined {return this.#terminal;}
  public get assistant(): string {return this.#assistant;}
  public admit(message: CodexJsonRecord): void {
    this.#validationRule = "envelope";
    const {method, params} = ordinaryCodexNotification(message);
    // This pinned account-scoped notification carries no turn authority or output.
    if (method === "account/rateLimits/updated") {this.#validationRule = "rate_limits"; admitRateLimits(params); return;}
    if (!this.#started && ["remoteControl/status/changed", "thread/started", "warning"].includes(method)) {
      this.#validationRule = "startup";
      admitOrdinaryStartup(message, this.#threadId, this.#startup); return;
    }
    this.#validationRule = "scope";
    if (params.threadId !== this.#threadId || "turnId" in params && params.turnId !== this.#turnId) {refuse();}
    this.#validationRule = "post_terminal";
    if (this.#terminal !== undefined && method !== "thread/status/changed") {refuse();}
    if (method === "thread/status/changed") {this.#status(params); return;}
    if (method === "turn/started") {this.#start(params); return;}
    this.#validationRule = "before_start";
    if (!this.#started) {refuse();}
    if (method === "item/started" || method === "item/completed") {
      this.#item(method, params);
      return;
    }
    if (Object.hasOwn(deltaKeys, method)) {
      this.#validationRule = "delta_shape";
      if (!exact(params, deltaKeys[method]!)) {refuse();}
      this.#validationRule = "item_delta";
      this.#items.delta(method, params); return;
    }
    if (method === "turn/completed") {
      this.#complete(params); return;
    }
    this.#validationRule = "passive";
    admitPassive(method, params);
  }
  #complete(params: CodexJsonRecord): void {
    this.#validationRule = "turn_complete_shape";
    if (!exact(params, ["threadId", "turn"])) {refuse();}
    const turn = ordinaryCodexTurn(params.turn);
    this.#validationRule = "turn_complete_state";
    if (turn.id !== this.#turnId || !["completed", "failed"].includes(String(turn.status))) {refuse();}
    if (this.#systemError && turn.status !== "failed") {refuse();}
    this.#validationRule = "terminal_items";
    this.#assistant = this.#items.terminal(turn); this.#terminal = turn;
  }
  #item(method: string, params: CodexJsonRecord): void {
      this.#validationRule = "item_shape";
      const time = method === "item/started" ? "startedAtMs" : "completedAtMs";
      if (!exact(params, ["item", "threadId", "turnId", time]) || !Number.isSafeInteger(params[time])) {refuse();}
      this.#validationRule = method === "item/started" ? "item_start" : "item_complete";
      if (method === "item/started") {this.#items.start(params.item);} else {this.#items.complete(params.item);}
  }
  #status(params: CodexJsonRecord): void {
    this.#validationRule = "status";
    if (!exact(params, ["threadId", "status"]) || !isRecord(params.status)) {refuse();}
    if (equalStatus(params.status, "idle")) {return;}
    if (equalStatus(params.status, "systemError") && this.#terminal?.status !== "completed") {this.#systemError = true; return;}
    if (this.#terminal !== undefined || params.status.type !== "active" ||
        !exact(params.status, ["type", "activeFlags"]) || !Array.isArray(params.status.activeFlags) || params.status.activeFlags.length !== 0) {refuse();}
  }
  #start(params: CodexJsonRecord): void {
    this.#validationRule = "turn_start";
    if (this.#started || !exact(params, ["threadId", "turn"])) {refuse();}
    const turn = ordinaryCodexTurn(params.turn);
    if (turn.id !== this.#turnId || turn.status !== "inProgress") {refuse();}
    this.#started = true;
  }

}
const equalStatus = (value: CodexJsonRecord, type: string): boolean => ordinaryJson(value) === ordinaryJson({type});

function admitRateLimits(params: CodexJsonRecord): void {
  if (!exact(params, ["rateLimits"]) || !isRecord(params.rateLimits)) {return refuse();}
  const limits = params.rateLimits;
  if (!exact(limits, ["limitId", "limitName", "primary", "secondary", "credits", "individualLimit", "spendControlReached", "planType", "rateLimitReachedType"]) ||
      [limits.limitId, limits.limitName, limits.planType, limits.rateLimitReachedType].some(value => value !== null && typeof value !== "string") ||
      limits.spendControlReached !== null && typeof limits.spendControlReached !== "boolean") {return refuse();}
  for (const value of [limits.primary, limits.secondary]) {admitRateWindow(value);}
  admitCredits(limits.credits);
  admitSpendLimit(limits.individualLimit);
}

function admitRateWindow(value: unknown): void {
    if (value !== null && (!isRecord(value) || !exact(value, ["usedPercent", "windowDurationMins", "resetsAt"]) ||
        typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 ||
        [value.windowDurationMins, value.resetsAt].some(field => field !== null && (!Number.isSafeInteger(field) || Number(field) < 0)))) {refuse();}
}

function admitCredits(credits: unknown): void {
  if (credits !== null && (!isRecord(credits) || !exact(credits, ["hasCredits", "unlimited", "balance"]) ||
      typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean" || credits.balance !== null && typeof credits.balance !== "string")) {refuse();}
}

function admitSpendLimit(spend: unknown): void {
  if (spend !== null && (!isRecord(spend) || !exact(spend, ["limit", "used", "remainingPercent", "resetsAt"]) ||
      typeof spend.limit !== "string" || typeof spend.used !== "string" || typeof spend.remainingPercent !== "number" ||
      !Number.isFinite(spend.remainingPercent) || !Number.isSafeInteger(spend.resetsAt))) {refuse();}
}

function admitPassive(method: string, params: CodexJsonRecord): void {
    if (method === "error" && exact(params, ["threadId", "turnId", "error", "willRetry"]) && params.willRetry === false && isRecord(params.error)) {return;}
    if (method === "thread/tokenUsage/updated" && exact(params, ["threadId", "turnId", "tokenUsage"]) && isRecord(params.tokenUsage)) {return;}
    if (method === "turn/diff/updated" && exact(params, ["threadId", "turnId", "diff"]) && typeof params.diff === "string") {return;}
    if (method === "turn/plan/updated" && exact(params, ["threadId", "turnId", "plan", "explanation"]) && Array.isArray(params.plan)) {return;}
    refuse();
}
