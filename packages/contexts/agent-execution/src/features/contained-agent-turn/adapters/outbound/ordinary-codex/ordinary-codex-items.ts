import {isAbsolute, relative, resolve} from "node:path";
import {isCodexRecord as isRecord} from "../codex-app-server/codex-app-server-jsonl.js";
import {validateAndNormalizeCodexThreadItem} from "../codex-app-server/codex-app-server-item-schema.js";
import {ordinaryCodexRefusal as refuse, ordinaryJson} from "./ordinary-codex-config.js";

const completionRules = {text: "complete_text", phase: "complete_phase", content: "complete_content", summary: "complete_summary",
  processId: "complete_process", command: "complete_command", commandActions: "complete_actions", changes: "complete_changes",
  delivery: "complete_delivery", questions: "complete_questions", memoryCitation: "complete_memory", clientId: "complete_client",
  cwd: "complete_cwd", source: "complete_source", pluginId: "complete_plugin", scriptPath: "complete_script"} as const;
export type OrdinaryCodexItemRule = typeof completionRules[keyof typeof completionRules] | "agent_delivery" | "agent_questions" | "agent_memory" | "user_content" | "item_schema_agent_message" | "item_schema_user_message" | "item_schema_reasoning" |
  "item_schema_plan" | "item_schema_command" | "item_schema_file_change" | "item_schema" | "item_policy" | "item_paths" | "item_start_state" | "item_delta_state" |
  "item_reasoning" | "item_complete_state" | "item_complete_output" | "item_complete_fields" | "item_terminal";
type Mark = (rule: OrdinaryCodexItemRule) => void;
const noMark: Mark = () => {};
type Item = Record<string, unknown>;
const itemKeys: Readonly<Record<string, readonly string[]>> = Object.freeze({
  agentMessage: ["id", "text", "type", "delivery", "memoryCitation", "phase", "questions"],
  userMessage: ["id", "type", "clientId", "content"],
  reasoning: ["id", "type", "summary", "content"],
  plan: ["id", "type", "text"],
  commandExecution: ["id", "type", "command", "commandActions", "cwd", "status", "aggregatedOutput", "durationMs", "exitCode", "pluginId", "processId", "scriptPath", "source"],
  fileChange: ["id", "type", "changes", "status"],
});
const present = (value: unknown): boolean => value !== null && value !== undefined;
const equal = (left: unknown, right: unknown): boolean => ordinaryJson(left) === ordinaryJson(right);
const inside = (cwd: string, value: unknown): boolean => {
  if (typeof value !== "string" || !value || value.includes("\0")) {return false;}
  const part = relative(cwd, resolve(cwd, value));
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};
const validatePaths = (item: Item, cwd: string): void => {
  if (item.type === "commandExecution") {
    if (item.cwd !== cwd || present(item.pluginId) || present(item.scriptPath) || !["agent", "unifiedExecStartup", "unifiedExecInteraction"].includes(String(item.source)) ||
        !Array.isArray(item.commandActions) || item.commandActions.some(action => !isRecord(action) ||
          present(action.path) && !inside(cwd, action.path))) {refuse();}
  }
  if (item.type === "fileChange") {
    if (!Array.isArray(item.changes) || item.changes.some(change => !isRecord(change) || !inside(cwd, change.path) ||
        !isRecord(change.kind) || present(change.kind.move_path) && !inside(cwd, change.kind.move_path))) {refuse();}
  }
};
function markItemSchema(value: unknown, mark: Mark): void {
  mark("item_schema");
  if (isRecord(value)) {
    switch (value.type) {
      case "agentMessage": mark("item_schema_agent_message"); break;
      case "userMessage": mark("item_schema_user_message"); break;
      case "reasoning": mark("item_schema_reasoning"); break;
      case "plan": mark("item_schema_plan"); break;
      case "commandExecution": mark("item_schema_command"); break;
      case "fileChange": mark("item_schema_file_change"); break;
    }
  }
}
export function ordinaryCodexItem(value: unknown, cwd: string, mark: Mark = noMark): Item {
  markItemSchema(value, mark);
  const item = validateAndNormalizeCodexThreadItem(value);
  if (!item || typeof item.id !== "string" || !item.id || typeof item.type !== "string" ||
      !Object.hasOwn(itemKeys, item.type) || !Object.keys(item).every(key => itemKeys[item.type as string]!.includes(key))) {return refuse();}
  mark("item_policy");
  if (item.type === "agentMessage") {
    mark("agent_questions"); if (item.questions !== null) {refuse();}
    mark("agent_memory"); if (item.memoryCitation !== null) {refuse();}
    mark("agent_delivery"); if (item.delivery !== null) {refuse();}
  }
  mark("user_content");
  if (item.type === "userMessage" && (!Array.isArray(item.content) || item.content.some(content => !isRecord(content) || content.type !== "text"))) {refuse();}
  mark("item_paths");
  validatePaths(item, cwd);
  return item;
}

/** Ordinary effects are admitted under ADR-0020, never converted into custody receipts. */
export class OrdinaryCodexItems {
  readonly #cwd: string;
  readonly #mark: Mark;
  readonly #active = new Map<string, Item>();
  readonly #seen = new Set<string>();
  readonly #completed: Item[] = [];
  #assistant = "";
  public constructor(cwd: string, mark: Mark = noMark) {this.#cwd = cwd; this.#mark = mark;}
  public start(value: unknown): void {
    const item = ordinaryCodexItem(value, this.#cwd, this.#mark); const id = String(item.id);
    this.#mark("item_start_state");
    if (this.#seen.has(id) || this.#seen.size >= 256 ||
        ["commandExecution", "fileChange"].includes(String(item.type)) && item.status !== "inProgress" ||
        item.type === "agentMessage" && item.text !== "") {refuse();}
    this.#seen.add(id); this.#active.set(id, item);
  }
  public delta(method: string, params: Item): void {
    this.#mark("item_delta_state");
    const item = this.#active.get(String(params.itemId));
    if (!item) {return refuse();}
    if (method === "item/agentMessage/delta" && item.type === "agentMessage" || method === "item/plan/delta" && item.type === "plan") {
      if (typeof params.delta !== "string" || typeof item.text !== "string") {refuse();}
      item.text += String(params.delta); return;
    }
    if (method === "item/commandExecution/outputDelta" && item.type === "commandExecution") {
      if (typeof params.delta !== "string") {refuse();}
      item.aggregatedOutput = String(item.aggregatedOutput ?? "") + String(params.delta); return;
    }
    if (method === "item/fileChange/patchUpdated" && item.type === "fileChange") {
      const updated = ordinaryCodexItem({...item, changes: params.changes}, this.#cwd, this.#mark);
      item.changes = updated.changes; return;
    }
    if (method === "item/fileChange/outputDelta" && item.type === "fileChange" && typeof params.delta === "string") {return;}
    if (item.type === "reasoning") {this.#reasoning(method, params, item); return;}
    refuse();
  }
  #reasoning(method: string, params: Item, item: Item): void {
    this.#mark("item_reasoning");
    if (!Array.isArray(item.summary) || !Array.isArray(item.content)) {refuse();}
    const summary = item.summary as unknown[]; const content = item.content as unknown[];
    if (method === "item/reasoning/summaryPartAdded" && params.summaryIndex === summary.length) {summary.push(""); return;}
    const index = method === "item/reasoning/summaryTextDelta" ? params.summaryIndex : params.contentIndex;
    const values = method === "item/reasoning/summaryTextDelta" ? summary : content;
    if (!["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"].includes(method) ||
        !Number.isSafeInteger(index) || Number(index) < 0 || Number(index) > values.length || typeof params.delta !== "string") {refuse();}
    if (Number(index) === values.length && values === content) {values.push("");}
    if (typeof values[Number(index)] !== "string") {refuse();}
    values[Number(index)] = String(values[Number(index)]) + String(params.delta);
  }
  public complete(value: unknown): void {
    const item = ordinaryCodexItem(value, this.#cwd, this.#mark); const id = String(item.id); const active = this.#active.get(id);
    this.#mark("item_complete_state");
    if (!active || active.type !== item.type) {return refuse();}
    const mutable = item.type === "commandExecution" ? ["status", "durationMs", "exitCode"] : item.type === "fileChange" ? ["status"] : [];
    if (mutable.length && item.status === "inProgress") {refuse();}
    const keys = new Set([...Object.keys(item), ...Object.keys(active)]);
    for (const key of keys) {
      if (mutable.includes(key)) {continue;}
      // Quick unified-exec commands may publish their entire output only in item/completed.
      if (key === "aggregatedOutput" && item.type === "commandExecution") {this.#mark("item_complete_output"); if (!String(item[key] ?? "").startsWith(String(active[key] ?? ""))) {refuse();}}
      else {
        this.#mark(Object.hasOwn(completionRules, key) ? completionRules[key as keyof typeof completionRules] : "item_complete_fields");
        if (!equal(active[key], item[key])) {refuse();}
      }
    }
    if (item.type === "agentMessage") {this.#assistant += String(item.text);}
    this.#active.delete(id); this.#completed.push(item);
  }
  public terminal(turn: Item): string {
    this.#mark("item_terminal");
    if (this.#active.size !== 0 || !Array.isArray(turn.items)) {return refuse();}
    // 0.153.4 summaries can omit items; complete lifecycle evidence remains authoritative.
    if (turn.itemsView === "notLoaded") {if (turn.items.length !== 0) {refuse();}}
    else if (turn.itemsView === "summary") {
      let cursor = 0;
      for (const raw of turn.items) {
        const item = ordinaryCodexItem(raw, this.#cwd);
        while (cursor < this.#completed.length && this.#completed[cursor]?.id !== item.id) {cursor += 1;}
        if (!equal(this.#completed[cursor], item)) {refuse();}
        cursor += 1;
      }
    }
    else if (turn.itemsView !== "full" || !equal(turn.items.map(item => ordinaryCodexItem(item, this.#cwd)), this.#completed)) {refuse();}
    return this.#assistant;
  }
}
