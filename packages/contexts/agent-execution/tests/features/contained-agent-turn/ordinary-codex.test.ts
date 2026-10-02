import assert from "node:assert/strict";
import test from "node:test";
import {OrdinaryCodexItems} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-items.js";
import {OrdinaryCodexProtocol, OrdinaryCodexTurnEvents} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-protocol.js";
import {createOrdinaryCodexAdapter, type OrdinaryCodexObservation} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-codex/ordinary-codex-provider.js";
import {sealOrdinaryChannel} from "../../../dist/features/contained-agent-turn/adapters/outbound/ordinary-channel/ordinary-byte-channel.js";

const cwd = "/ordinary-codex-TEST/workspace";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A sealed channel whose stdout arrives as the given chunks; `state.clean` records the framing EOF confirmation. */
const channel = (chunks: Uint8Array[], state: {writes: Uint8Array[]; clean: boolean; closed: boolean} = {writes: [], clean: false, closed: false}) => ({
  state,
  transport: sealOrdinaryChannel({
    read: async () => chunks.shift(), write: async data => {state.writes.push(data);},
    closeInput: async () => {state.closed = true;}, confirmCleanFraming: () => {state.clean = true;},
  }),
});
const protocolOver = (chunks: Uint8Array[]) => {const {state, transport} = channel(chunks); return {state, protocol: new OrdinaryCodexProtocol(transport, performance.now() + 500, new AbortController().signal)};};
const notify = (method: string, params: Record<string, unknown>) => ({method, params});
const turn = (status = "inProgress") => ({id: "01a09662-a294-74f2-8672-91eef1cde972", status, items: [], itemsView: "notLoaded", error: null,
  startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1000});
const agent = (text: string) => ({type: "agentMessage", id: "message-1", text});
const started = () => {
  const events = new OrdinaryCodexTurnEvents("01a09662-a230-7960-b2b1-b27e62a503fd", "01a09662-a294-74f2-8672-91eef1cde972", cwd);
  events.admit(notify("turn/started", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: turn()}));
  return events;
};
const itemNotice = (kind: "started" | "completed", item: unknown) => notify(`item/${kind}`, {
  threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", item, [kind === "started" ? "startedAtMs" : "completedAtMs"]: 1000,
});

test("ordinary 0.153.4 ephemeral terminal closes observed items even when terminal items are not loaded", () => {
  const events = started();
  events.admit(itemNotice("started", agent("")));
  events.admit(notify("item/agentMessage/delta", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", itemId: "message-1", delta: "ordinary text"}));
  events.admit(itemNotice("completed", agent("ordinary text")));
  events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: turn("completed")}));
  events.admit(notify("thread/status/changed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", status: {type: "idle"}}));
  assert.equal(events.terminal?.status, "completed"); assert.equal(events.assistant, "ordinary text");
  assert.throws(() => events.admit(itemNotice("started", agent(""))), /EVIDENCE_REJECTED/u);
});

test("ordinary terminal rejects missing item closure, terminal mismatch and assistant text substitution", () => {
  const events = started(); events.admit(itemNotice("started", agent("")));
  assert.throws(() => events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: turn("completed")})), /EVIDENCE_REJECTED/u);
  events.admit(notify("item/agentMessage/delta", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", itemId: "message-1", delta: "observed prefix"}));
  assert.throws(() => events.admit(itemNotice("completed", agent("unobserved text"))), /EVIDENCE_REJECTED/u);
  const other = started();
  assert.throws(() => other.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: {...turn("completed"), itemsView: "full", items: [agent("unobserved")]}})), /EVIDENCE_REJECTED/u);
});

test("ordinary command effects have an explicit workspace boundary without fabricating custody", () => {
  const items = new OrdinaryCodexItems(cwd);
  const command = {id: "cmd-1", type: "commandExecution", command: "cat TASK.md", commandActions: [], cwd,
    status: "inProgress", aggregatedOutput: null, processId: "73883", source: "unifiedExecStartup", exitCode: null, durationMs: null};
  items.start(command);
  items.delta("item/commandExecution/outputDelta", {itemId: "cmd-1", delta: "task text"});
  assert.throws(() => items.complete({...command, status: "completed", aggregatedOutput: "different output", exitCode: 0, durationMs: 4}), /EVIDENCE_REJECTED/u);
  items.complete({...command, status: "completed", aggregatedOutput: "task text plus buffered tail", exitCode: 0, durationMs: 4});
  const quick = new OrdinaryCodexItems(cwd); quick.start(command);
  quick.complete({...command, status: "completed", aggregatedOutput: "buffered quick output", exitCode: 0, durationMs: 0});
  assert.equal(quick.terminal(turn("completed")), "");
  assert.equal(items.terminal(turn("completed")), "");
  assert.throws(() => new OrdinaryCodexItems(cwd).start({...command, source: "userShell"}), /EVIDENCE_REJECTED/u);
  assert.throws(() => new OrdinaryCodexItems(cwd).start({...command, cwd: "/"}), /EVIDENCE_REJECTED/u);
  assert.throws(() => new OrdinaryCodexItems(cwd).start({id: "file", type: "fileChange", status: "inProgress", changes: [{path: "../escape", diff: "x", kind: {type: "add"}}]}), /EVIDENCE_REJECTED/u);
  assert.throws(() => new OrdinaryCodexItems(cwd).start({id: "mcp", type: "mcpToolCall"}), /EVIDENCE_REJECTED/u);
});

test("ordinary protocol rejects replay, foreign scope, unexpected requests and retry intent", () => {
  const events = started();
  events.admit(itemNotice("started", agent("")));
  assert.throws(() => events.admit(itemNotice("started", agent(""))), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit(notify("error", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", error: {}, willRetry: true})), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit({id: "approval", method: "item/commandExecution/requestApproval", params: {}}), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit(notify("thread/status/changed", {threadId: "foreign", status: {type: "idle"}})), /EVIDENCE_REJECTED/u);
});

test("late thread/start notification is correlated once before active turn", () => {
  const events = new OrdinaryCodexTurnEvents("01a09662-a230-7960-b2b1-b27e62a503fd", "01a09662-a294-74f2-8672-91eef1cde972", cwd);
  const notice = notify("thread/started", {thread: {id: "01a09662-a230-7960-b2b1-b27e62a503fd"}});
  events.admit(notice);
  assert.throws(() => events.admit(notice), /EVIDENCE_REJECTED/u);
});

test("provider systemError is observed before a failed terminal and cannot become success", () => {
  const events = started();
  events.admit(notify("thread/status/changed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", status: {type: "systemError"}}));
  assert.throws(() => events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: turn("completed")})), /EVIDENCE_REJECTED/u);
  events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: {...turn("failed"), error: {
    message: "synthetic503", codexErrorInfo: "other", additionalDetails: null, misalignment: null,
  }}}));
  assert.equal(events.terminal?.status, "failed");
});

test("JSONL rejects duplicate decoded property names and RPC never retries an unknown reply", async () => {
  for (const response of ['{"id":"request","id":"request","result":{}}', '{"id":"request","re\\u0073ult":{},"result":{}}', '{"id":"foreign","result":{}}']) {
    const {state, protocol} = protocolOver([bytes(`${response}\n`)]);
    await assert.rejects(protocol.request("request", "turn/start", {}));
    assert.equal(state.writes.length, 1);
  }
});

test("aborted request writes zero protocol commands", async () => {
  const controller = new AbortController(); controller.abort();
  const {state, transport} = channel([]);
  const protocol = new OrdinaryCodexProtocol(transport, performance.now() + 500, controller.signal);
  await assert.rejects(protocol.request("request", "turn/start", {})); assert.equal(state.writes.length, 0);
});

test("a handle that was not sealed by the ordinary process owner is refused", () => {
  assert.throws(() => new OrdinaryCodexProtocol(Object.freeze({}) as never, performance.now() + 500, new AbortController().signal), /EVIDENCE_REJECTED/u);
});

test("single framing pass strips CR, skips empty lines and confirms a clean EOF only after the last byte", async () => {
  const {state, protocol} = protocolOver([bytes('\r\n{"a":1}\r\n\n{"b"'), bytes(':2}\n')]);
  assert.deepEqual(await protocol.next(), {a: 1}); assert.equal(state.clean, false);
  assert.deepEqual(await protocol.next(), {b: 2}); assert.equal(state.clean, false);
  assert.equal(await protocol.next(), undefined); assert.equal(state.clean, true);
});

test("framing refuses an unterminated tail on EOF and never confirms a clean EOF", async () => {
  const {state, protocol} = protocolOver([bytes('{"a":1}\n{"tail":')]);
  assert.deepEqual(await protocol.next(), {a: 1});
  await assert.rejects(protocol.next(), /unterminated/u); assert.equal(state.clean, false);
});

test("framing refuses malformed UTF-8, over-long lines and non-object messages", async () => {
  for (const chunk of [Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]), bytes(`${"a".repeat(262_145)}\n`), bytes("a".repeat(262_145)), bytes("[1]\n")]) {
    const {state, protocol} = protocolOver([chunk]);
    await assert.rejects(protocol.next()); assert.equal(state.clean, false);
  }
});

test("the 2048 message bound refuses the next message", async () => {
  const {protocol} = protocolOver([bytes('{"n":1}\n'.repeat(2049))]);
  for (let index = 0; index < 2048; index += 1) {assert.deepEqual(await protocol.next(), {n: 1});}
  await assert.rejects(protocol.next(), /EVIDENCE_REJECTED/u);
});

test("the 1 MiB JSON byte bound refuses the message that crosses it", async () => {
  const line = `${JSON.stringify({text: "x".repeat(200_000)})}\n`;
  const {protocol} = protocolOver([bytes(line.repeat(6))]);
  for (let index = 0; index < 5; index += 1) {await protocol.next();}
  await assert.rejects(protocol.next(), /EVIDENCE_REJECTED/u);
});

test("provider needs no prepared state: a fresh adapter runs from explicit credential facts and refuses after dispose", async () => {
  const observed: OrdinaryCodexObservation[] = [];
  const adapter = createOrdinaryCodexAdapter({executable: "/TEST/never-executed", record: event => {observed.push(event);}});
  const operation = {operationId: "operation:synthetic", attemptId: "attempt:synthetic", executionProfile: "user-session-v1", capabilityManifestRevision: "ordinary-codex-macos-arm64-0.153.4-v1"};
  const run = (state: ReturnType<typeof channel>) => adapter.provider.execute({operation, transport: state.transport, workspace: {workspaceId: "workspace:synthetic", cwd, homeDirectory: "/ordinary-codex-TEST/home"},
    credential: {brokerEndpoint: "http://127.0.0.1:1/v1", materializationId: "material:synthetic", generation: 1}, signal: new AbortController().signal, deadline: performance.now() + 500, emit: async () => {}} as never);
  const first = channel([]);
  await assert.rejects(run(first), /EVIDENCE_REJECTED/u);
  assert.equal(first.state.writes.length, 1); assert.ok(observed.some(event => event.stage === "initialize_request"));
  adapter.dispose();
  const second = channel([]);
  await assert.rejects(run(second), /EVIDENCE_REJECTED/u);
  assert.equal(second.state.writes.length, 0);
});


test("account-scoped rate limit notices carry no terminal or output authority", () => {
  const events = started();
  const rateLimits = {limitId: "codex", limitName: null, primary: null, secondary: null, credits: null,
    individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null};
  events.admit(notify("account/rateLimits/updated", {rateLimits}));
  assert.equal(events.terminal, undefined); assert.equal(events.assistant, "");
  assert.throws(() => events.admit(notify("account/rateLimits/updated", {rateLimits, threadId: "foreign"})), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit(notify("account/rateLimits/updated", {rateLimits: {...rateLimits, primary: {usedPercent: "invalid"}}})), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit({id: "request", ...notify("account/rateLimits/updated", {rateLimits})}), /EVIDENCE_REJECTED/u);
});

test("provider turn identifiers cannot carry arbitrary text into durable receipts", () => {
  const events = started();
  assert.throws(() => events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: {...turn("completed"), id: "private-token-text"}})), /EVIDENCE_REJECTED/u);
});


test("pinned summary terminal is an ordered subset of observed completed items", () => {
  const events = started();
  events.admit(itemNotice("started", agent("")));
  events.admit(notify("item/agentMessage/delta", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", itemId: "message-1", delta: "Done."}));
  events.admit(itemNotice("completed", agent("Done.")));
  const terminal = {...turn("completed"), itemsView: "summary", items: [agent("Done.")]};
  assert.throws(() => events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: {...terminal, items: [agent("substituted")]}})), /EVIDENCE_REJECTED/u);
  assert.throws(() => events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: {...terminal, items: [agent("Done."), agent("Done.")]}})), /EVIDENCE_REJECTED/u);
  events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: terminal}));
  assert.equal(events.assistant, "Done.");
});

test("refusal diagnostics classify untrusted events without exposing their values", () => {
  const secret = "synthetic-private-value";
  const cases: [Record<string, unknown>, string][] = [
    [{id: secret, method: secret, params: {}}, "envelope"],
    [notify(secret, {threadId: secret}), "scope"],
    [notify(secret, {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd"}), "passive"],
    [itemNotice("started", {type: "agentMessage", id: secret, text: 42}), "item_schema_agent_message"],
    [itemNotice("started", {...agent(""), questions: []}), "agent_questions"],
    [itemNotice("started", {...agent(secret)}), "item_start_state"],
  ];
  for (const [message, rule] of cases) {
    const events = started();
    assert.throws(() => events.admit(message), /EVIDENCE_REJECTED/u);
    assert.equal(events.validationRule, rule);
    assert.equal(events.validationRule.includes(secret), false);
    assert.equal(events.terminal, undefined);
  }
});

test("completion diagnostics distinguish text substitution from field drift and reset on the next event", () => {
  const events = started(); events.admit(itemNotice("started", agent("")));
  events.admit(notify("item/agentMessage/delta", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", itemId: "message-1", delta: "observed"}));
  assert.throws(() => events.admit(itemNotice("completed", agent("unobserved-private-text"))), /EVIDENCE_REJECTED/u);
  assert.equal(events.validationRule, "complete_text");
  assert.throws(() => events.admit(itemNotice("completed", {...agent("observed"), phase: "final_answer"})), /EVIDENCE_REJECTED/u);
  assert.equal(events.validationRule, "complete_phase");
  assert.throws(() => events.admit({id: "private-id", method: "private-method", params: {}}), /EVIDENCE_REJECTED/u);
  assert.equal(events.validationRule, "envelope");
});


test("agent completion snapshots may extend empty or partially streamed text without replacing observed prefixes", () => {
  for (const prefix of ["", "Final ", "Final answer."]) {
    const events = started(); events.admit(itemNotice("started", agent("")));
    if (prefix) {events.admit(notify("item/agentMessage/delta", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turnId: "01a09662-a294-74f2-8672-91eef1cde972", itemId: "message-1", delta: prefix}));}
    if (prefix) {
      for (const text of ["conflicting answer", prefix.slice(0, -1)]) {
        assert.throws(() => events.admit(itemNotice("completed", agent(text))), /EVIDENCE_REJECTED/u);
        assert.equal(events.validationRule, "complete_text");
      }
    }
    assert.throws(() => events.admit(itemNotice("completed", {...agent("Final answer."), text: 42})), /EVIDENCE_REJECTED/u);
    assert.throws(() => events.admit(itemNotice("completed", {type: "plan", id: "message-1", text: "Final answer."})), /EVIDENCE_REJECTED/u);
    events.admit(itemNotice("completed", agent("Final answer.")));
    events.admit(notify("turn/completed", {threadId: "01a09662-a230-7960-b2b1-b27e62a503fd", turn: turn("completed")}));
    assert.equal(events.assistant, "Final answer.");
    assert.equal(events.terminal?.status, "completed");
  }
});


test("plan completion requires exact streamed text including when no delta was observed", () => {
  const items = new OrdinaryCodexItems(cwd);
  const plan = {type: "plan", id: "plan-1", text: ""};
  items.start(plan);
  assert.throws(() => items.complete({...plan, text: "Final-only plan"}), /EVIDENCE_REJECTED/u);
  items.delta("item/plan/delta", {itemId: "plan-1", delta: "Step 1"});
  assert.throws(() => items.complete({...plan, text: "Replacement"}), /EVIDENCE_REJECTED/u);
  assert.throws(() => items.complete({...plan, text: "Step 1: verify."}), /EVIDENCE_REJECTED/u);
  items.complete({...plan, text: "Step 1"});
  assert.equal(items.terminal(turn("completed")), "");
});
