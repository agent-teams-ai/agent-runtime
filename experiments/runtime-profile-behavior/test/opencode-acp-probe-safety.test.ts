import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import {
  AgentApp,
  ClientApp,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

import {
  MAX_EVIDENCE_ANOMALIES,
  MAX_RETAINED_CALLBACKS,
  ProbeEvidence,
} from "../src/features/acp-compatibility/opencode-acp-probe-evidence.ts";
import {
  awaitBoundedConnectionClose,
  terminateBoundedProcess,
} from "../src/features/acp-compatibility/opencode-acp-probe-lifecycle.ts";
import { runIsolatedSdkWorkflow } from "../src/features/acp-compatibility/opencode-acp-probe-sdk-isolation.ts";
import {
  executeProbeWorkflow,
  requestWithDeadline,
} from "../src/features/acp-compatibility/opencode-acp-probe-workflow.ts";

test("projects retained evidence through bounded safe shapes", () => {
  const evidence = new ProbeEvidence();
  const secret = "TOKEN=raw-credential /workspace/private tool-argument";
  assert.deepEqual(evidence.sdkResult("initialize", { protocolVersion: 1, secret }), {
    result: { observed: true, protocolVersion: 1 },
  });
  assert.deepEqual(
    evidence.sdkResult("session/list", {
      sessions: [{ sessionId: "private-session", cwd: "/workspace/private" }],
    }),
    { result: { observed: true, contentsRetained: false } },
  );
  assert.equal(
    evidence.callback("permission", {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", arguments: { secret } },
      options: [{ name: secret }],
    })?.toolCallId,
    "tool-1",
  );
  const rejected = evidence.callback("available_commands", {
    sessionId: "session-1",
    update: {
      availableCommands: [{ name: "x".repeat(129), description: secret }],
    },
  });
  assert.equal(rejected, undefined);
  const error = evidence.error("request_rejected", "session/new", new Error(secret));
  const stderr = evidence.stderr(Buffer.from(secret), secret.length, false);
  const retained = JSON.stringify({ error, stderr, anomalies: evidence.anomalies });
  assert.doesNotMatch(retained, /raw-credential|workspace\/private|tool-argument/);
  assert.match(retained, /digestSha256/);
  assert.match(retained, /evidence_value_rejected/);
});

test("caps retained anomalies without preserving rejected values elsewhere", () => {
  const evidence = new ProbeEvidence();
  for (let index = 0; index < MAX_EVIDENCE_ANOMALIES + 10; index += 1) {
    evidence.anomaly("evidence_value_rejected", `field-${index}`, { huge: "z".repeat(10_000) });
  }
  assert.equal(evidence.anomalies.length, MAX_EVIDENCE_ANOMALIES);
  assert.deepEqual(evidence.anomalies.at(-1), {
    code: "evidence_anomaly_limit_exceeded",
  });
  assert.ok(JSON.stringify(evidence.anomalies).length < 10_000);
  assert.doesNotMatch(JSON.stringify(evidence.anomalies), /z{100}/);
});

test("ordinary Error digests distinguish failures without retaining messages", () => {
  const evidence = new ProbeEvidence();
  const first = evidence.error(
    "request_rejected",
    "session/new",
    new Error("TOKEN=first-secret"),
  );
  const second = evidence.error(
    "request_rejected",
    "session/new",
    new Error("TOKEN=second-secret"),
  );
  assert.notEqual(first.digestSha256, second.digestSha256);
  assert.doesNotMatch(JSON.stringify({ first, second }), /first-secret|second-secret|TOKEN/);
});

test("caps callback evidence before retention", () => {
  const evidence = new ProbeEvidence();
  const callback = {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1", arguments: { secret: "not-retained" } },
  };
  for (let index = 0; index < MAX_RETAINED_CALLBACKS + 1; index += 1) {
    evidence.callback("permission", callback);
  }
  assert.equal(evidence.callbacks.length, MAX_RETAINED_CALLBACKS);
  assert.equal(evidence.anomalies.at(-1)?.code, "evidence_value_rejected");
  assert.doesNotMatch(JSON.stringify(evidence.callbacks), /not-retained|arguments/);
});

test("fails closed on ordinary SDK request rejection", async () => {
  const evidence = new ProbeEvidence();
  await assert.rejects(
    requestWithDeadline({
      method: "session/new",
      invoke: async () => Promise.reject(new Error("provider rejected with secret")),
      timeoutMs: 100,
      evidence,
    }),
    /request_rejected/,
  );
  assert.equal(evidence.anomalies[0]?.code, "request_rejected");
  assert.doesNotMatch(JSON.stringify(evidence.anomalies), /provider rejected|secret/);
});

test("sets a typed workflow error on rejected initialize", async () => {
  const evidence = new ProbeEvidence();
  const connection = {
    agent: {
      request: async () => Promise.reject(new Error("initialize rejected")),
    },
  } as unknown as ClientConnection;
  const workflow = await executeProbeWorkflow({
    connection,
    evidence,
    requestedProtocolVersion: 1,
    workspace: "/transient/workspace",
    executePrompt: false,
    configDriftAction: "mutate",
    deadlineAt: Date.now() + 1_000,
  });
  assert.equal(workflow.workflowError?.code, "request_rejected");
  assert.equal(workflow.initialize, undefined);
});

test("fails closed when initialize negotiates an unsupported version", async () => {
  const evidence = new ProbeEvidence();
  const connection = {
    agent: {
      request: async () => ({ protocolVersion: 2 }),
    },
  } as unknown as ClientConnection;
  const workflow = await executeProbeWorkflow({
    connection,
    evidence,
    requestedProtocolVersion: 2,
    workspace: "/transient/workspace",
    executePrompt: false,
    configDriftAction: "mutate",
    deadlineAt: Date.now() + 1_000,
  });
  assert.equal(workflow.workflowError?.code, "workflow_failed");
  assert.equal(workflow.initialize?.result.protocolVersion, 2);
});

test("classifies request timeout as bounded ambiguity, never success", async () => {
  const evidence = new ProbeEvidence();
  await assert.rejects(
    requestWithDeadline({
      method: "session/prompt",
      invoke: async () => new Promise<never>(() => {}),
      timeoutMs: 5,
      evidence,
    }),
    /request_timeout_ambiguity/,
  );
  assert.deepEqual(evidence.anomalies, [
    { code: "request_timeout_ambiguity", field: "session/prompt" },
  ]);
});

test("retains a safe anomaly for a rejection after request timeout", async () => {
  const evidence = new ProbeEvidence();
  const late = Promise.withResolvers<never>();
  await assert.rejects(
    requestWithDeadline({
      method: "session/prompt",
      invoke: () => late.promise,
      timeoutMs: 5,
      evidence,
    }),
    /request_timeout_ambiguity/,
  );
  late.reject(new Error("TOKEN=late-provider-secret"));
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(
    evidence.anomalies.at(-1)?.code,
    "late_request_rejected_after_timeout",
  );
  assert.doesNotMatch(JSON.stringify(evidence.anomalies), /late-provider-secret|TOKEN/);
});

test("retains a typed anomaly when SDK connection closure times out", async () => {
  const evidence = new ProbeEvidence();
  let closeCalled = false;
  const outcome = await awaitBoundedConnectionClose({
    connection: {
      close: () => {
        closeCalled = true;
      },
      closed: new Promise<void>(() => {}),
    },
    timeoutMs: 5,
    evidence,
  });
  assert.equal(closeCalled, true);
  assert.equal(outcome, "closure_timeout");
  assert.deepEqual(evidence.anomalies, [
    { code: "closure_timeout", field: "sdk_connection" },
  ]);
});

test("observes normal official SDK in-memory connection close", async () => {
  const evidence = new ProbeEvidence();
  const connection = new ClientApp({ name: "probe-close-test" }).connect(
    new AgentApp({ name: "probe-close-agent" }),
  );
  assert.equal(
    await awaitBoundedConnectionClose({ connection, timeoutMs: 100, evidence }),
    "closed",
  );
  assert.deepEqual(evidence.anomalies, []);
});

test("contains official SDK diagnostics for synthetic malformed stdout", async () => {
  const evidence = new ProbeEvidence();
  const secret = `TOKEN=malformed-provider-secret /synthetic/private ${"x".repeat(70_000)}`;
  const encoder = new TextEncoder();
  const fromAgent = Readable.toWeb(
    Readable.from([encoder.encode(`{"unterminated":"${secret}"\n`)]),
  ) as ReadableStream<Uint8Array>;
  const toAgent = Writable.toWeb(
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  ) as WritableStream<Uint8Array>;
  const result = await runIsolatedSdkWorkflow({
    fromAgent,
    toAgent,
    requestedProtocolVersion: 1,
    workspace: "/synthetic/private",
    executePrompt: false,
    configDriftAction: "mutate",
    deadlineAt: Date.now() + 5_000,
    timeoutMs: 8_000,
    evidence,
  });
  const retained = JSON.stringify(result);
  assert.notEqual(result.workflow.workflowError, undefined);
  assert.ok(
    result.diagnostics.stderr.bytesObserved +
      result.diagnostics.stdout.bytesObserved >
      0,
    JSON.stringify(result.diagnostics),
  );
  assert.match(result.diagnostics.stderr.digestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.diagnostics.stderr.truncated, true);
  assert.ok(retained.length < 10_000);
  assert.doesNotMatch(retained, /malformed-provider-secret|synthetic\/private|TOKEN/);
});

test("releases stubborn child handles after bounded SIGKILL uncertainty", async () => {
  const evidence = new ProbeEvidence();
  const calls: string[] = [];
  const handle = (name: string) => ({
    destroy: () => {
      calls.push(name);
    },
  });
  const startedAt = Date.now();
  const result = await terminateBoundedProcess({
    child: {
      kill: (signal?: NodeJS.Signals | number) => {
        calls.push(String(signal));
        return true;
      },
      stdin: handle("stdin"),
      stdout: handle("stdout"),
      stderr: handle("stderr"),
      unref: () => {
        calls.push("unref");
      },
    } as never,
    exit: new Promise(() => {}),
    gracefulMs: 5,
    sigtermMs: 5,
    sigkillMs: 5,
    evidence,
  });
  assert.equal(result.termination, "unconfirmed_after_sigkill");
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(calls, ["SIGTERM", "SIGKILL", "stdin", "stdout", "stderr", "unref"]);
  assert.equal(evidence.anomalies.at(-1)?.code, "termination_unconfirmed");
});

test("a successful late settlement cannot replace timeout ambiguity", async () => {
  const evidence = new ProbeEvidence();
  const late = Promise.withResolvers<{ stopReason: string }>();
  const request = requestWithDeadline({
    method: "session/prompt", invoke: () => late.promise, timeoutMs: 5, evidence,
  });
  await assert.rejects(request, /request_timeout_ambiguity/);
  late.resolve({ stopReason: "end_turn" });
  await new Promise(resolve => {setImmediate(resolve);});
  await assert.rejects(request, /request_timeout_ambiguity/);
  assert.deepEqual(evidence.anomalies, [
    { code: "request_timeout_ambiguity", field: "session/prompt" },
    { code: "late_request_resolved_after_timeout", field: "session/prompt" },
  ]);
});

test("throwing close and rejected closed retain bounded failure before cleanup", async () => {
  for (const throws of [true, false]) {
    const evidence = new ProbeEvidence();
    const outcome = await awaitBoundedConnectionClose({
      connection: {
        close: () => {if (throws) {throw new Error("TOKEN=close-secret");}},
        closed: Promise.reject(new Error("TOKEN=closed-secret")),
      },
      timeoutMs: 5, evidence,
    });
    assert.equal(outcome, "closure_failed");
    assert.ok(evidence.anomalies.every(value => value.code === "closure_failed"));
    assert.ok(evidence.anomalies.length > 0);
    assert.doesNotMatch(JSON.stringify(evidence.anomalies), /TOKEN|secret/);
  }
});
