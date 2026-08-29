import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  AcpWireClient,
  AcpWireProtocolError,
  AcpWireTransportError,
  parseInitializeResult,
  type AcpWireScheduler,
} from "../src/features/acp-compatibility/acp-wire.ts";
import {
  classifyOpenCodeCallback,
  classifyOpenCodeCancellation,
  classifyOpenCodeNotification,
  mapOpenCodeCapabilities,
  OPENCODE_ACP_REQUEST_TIMEOUT_DEFAULT_MS,
  readOpenCodeAcpRequestTimeoutMs,
  requireSupportedOpenCodeCapability,
} from "../src/features/acp-compatibility/opencode-acp-validation.ts";

const fixtureRoot = join(
  process.cwd(),
  "experiments/runtime-profile-behavior/fixtures/acp-compatibility",
);

const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(fixtureRoot, `${name}.json`), "utf8")) as Record<string, unknown>;

const frozenFixtureDigests: Readonly<Record<string, string>> = {
  "cancellation-ambiguity": "47dd29d894afab5731676b1ccdc77d1c662460f61a4982576d409b12125fe0c9",
  "initialize-v1": "761a184d65fda5cdfc6a89bb3e53f07f4ee4eb9f7fe444425dbbde4f02d93e85",
  "late-duplicate-messages": "07e13792a810b2db02f7fe92f4a798f9df09038f5cf576ecac88902d0c733783",
  "malformed-message": "de5569654387603988d20dfeddea26ae8c5a0da093d516bf0d6b1fce240006ed",
  "permission-tool-callbacks": "108297a9cf039413313ac1f859541d814d8793093dc9d36bf26e9a1903829b97",
  "process-exit": "b63a4a1d9405d47ac290ec21fd378a4cf3a2e949cc28fcc06a559aa1e8c94f38",
  "request-timeout": "2dbc4920e77612ed6b382dcf5b1c1a3d078fbd1e8c372aedf3d881c29576d18f",
  "session-capabilities": "a346d4194e6c9fb081530c3921de43a9fe5c03c4c3be48182812c4efa5622e16",
  "unknown-unsupported-capabilities": "2023230b896ee84b07d38a56063db88f02a8bb2c69b7e21f04e9e34a5a9139f8",
  "v2-to-v1-negotiation": "e6427ceecd01542e0f61ceaf16a711f18aa2359cf53a694eab3d0bc2dbe01452",
};

class ManualScheduler implements AcpWireScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #next = 1;

  public set(_delayMs: number, callback: () => void): number {
    const handle = this.#next++;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  public clear(handle: unknown): void {
    this.#callbacks.delete(handle as number);
  }

  public fireAll(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

const asArray = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};

test("locks deterministic ACP fixture bytes", async () => {
  for (const [name, expected] of Object.entries(frozenFixtureDigests)) {
    const bytes = await readFile(join(fixtureRoot, `${name}.json`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
  }
});

test("keeps the generic ACP wire seam provider and domain neutral", async () => {
  const source = await readFile(
    join(
      process.cwd(),
      "experiments/runtime-profile-behavior/src/features/acp-compatibility/acp-wire.ts",
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /opencode|contained-agent-turn|contained-turn|provider ports?/i);
  assert.doesNotMatch(source, /packages\/contexts\//);
});

test("replays initialize and explicit ACP v2-to-v1 negotiation fixtures", async () => {
  const v1 = await fixture("initialize-v1");
  const downgrade = await fixture("v2-to-v1-negotiation");

  assert.equal(parseInitializeResult(v1.response, [1]).protocolVersion, 1);
  assert.equal(parseInitializeResult(downgrade.response, [2, 1]).protocolVersion, 1);
  assert.throws(
    () => parseInitializeResult({ protocolVersion: 3 }, [2, 1]),
    (error: unknown) => error instanceof AcpWireProtocolError && error.code === "unsupported_protocol",
  );
});

test("maps new/list/resume/close and preserves exact unsupported capability truth", async () => {
  const all = await fixture("session-capabilities");
  const drift = await fixture("unknown-unsupported-capabilities");
  assert.deepEqual(mapOpenCodeCapabilities(all.response).session, all.expected);
  assert.deepEqual(all.results, {
    new: { sessionId: "fixture-session" },
    list: { sessions: [{ sessionId: "fixture-session", cwd: "/fixture" }] },
    resume: {},
    close: {},
  });

  const mapped = mapOpenCodeCapabilities(drift.response);
  assert.deepEqual(mapped.unknown, drift.expectedUnknown);
  assert.deepEqual(
    Object.entries(mapped.session).filter(([, supported]) => !supported).map(([name]) => name),
    drift.expectedUnsupported,
  );
  assert.throws(
    () => requireSupportedOpenCodeCapability(mapped, "resume"),
    (error: unknown) => error instanceof AcpWireProtocolError && error.code === "unsupported_protocol",
  );
});

test("frames split stdio input and correlates responses by request id", async () => {
  const writes: string[] = [];
  const client = new AcpWireClient({ requestTimeoutMs: 15_000, write: (line) => writes.push(line) });
  const first = client.request("session/new", { cwd: "/fixture" });
  const second = client.request("session/list", { cwd: "/fixture" });
  assert.match(writes[0] ?? "", /"id":1/);
  assert.match(writes[1] ?? "", /"id":2/);

  client.receive('{"jsonrpc":"2.0","id":2,"result":{"sessions":[]}}\n{"jsonrpc":"2.0",');
  client.receive('"id":1,"result":{"sessionId":"fixture-session"}}\n');
  assert.deepEqual(await first, { sessionId: "fixture-session" });
  assert.deepEqual(await second, { sessions: [] });
});

test("reports malformed, duplicate, and late messages without corrupting correlation", async () => {
  const malformed = await fixture("malformed-message");
  const repeated = await fixture("late-duplicate-messages");
  const errors: string[] = [];
  const client = new AcpWireClient({
    requestTimeoutMs: 15_000,
    write: () => {},
    onProtocolError: (error) => errors.push(error.code),
  });
  for (const chunk of asArray(malformed.chunks)) client.receive(String(chunk));
  const pending = client.request("initialize", { protocolVersion: 1 });
  for (const response of asArray(repeated.responses)) client.receive(`${JSON.stringify(response)}\n`);
  await pending;
  assert.deepEqual(errors, [
    ...asArray(malformed.expectedErrors),
    ...asArray(repeated.expectedErrors),
  ]);
});

test("routes permission/tool callbacks through OpenCode policy and rejects unknown callbacks", async () => {
  const callbackFixture = await fixture("permission-tool-callbacks");
  const writes: string[] = [];
  const observed: string[] = [];
  const client = new AcpWireClient({
    requestTimeoutMs: 15_000,
    write: (line) => writes.push(line),
    onRequest: (request) => {
      const disposition = classifyOpenCodeCallback(request.method);
      observed.push(disposition.kind);
      if (disposition.kind === "unsupported") throw new Error("Unsupported OpenCode callback");
      return { outcome: "deferred_to_runtime_authority", autoApproved: disposition.autoApproved };
    },
    onNotification: (notification) => {
      observed.push(classifyOpenCodeNotification(notification.method, notification.params).kind);
    },
  });
  for (const message of asArray(callbackFixture.messages)) client.receive(`${JSON.stringify(message)}\n`);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, callbackFixture.expected);
  assert.equal(writes.length, 2);
  assert.ok(writes.some((line) => /deferred_to_runtime_authority/.test(line)));
  assert.ok(writes.some((line) => /Unsupported OpenCode callback/.test(line)));
});

test("bounds OpenCode request timeout configuration deterministically", () => {
  assert.equal(readOpenCodeAcpRequestTimeoutMs({}), OPENCODE_ACP_REQUEST_TIMEOUT_DEFAULT_MS);
  assert.equal(
    readOpenCodeAcpRequestTimeoutMs({ AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS: "" }),
    OPENCODE_ACP_REQUEST_TIMEOUT_DEFAULT_MS,
  );
  assert.equal(readOpenCodeAcpRequestTimeoutMs({ AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS: "1000" }), 1_000);
  assert.equal(readOpenCodeAcpRequestTimeoutMs({ AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS: "120000" }), 120_000);
  for (const invalid of ["999", "120001", "1.5", "abc", "-1000"]) {
    assert.throws(
      () => readOpenCodeAcpRequestTimeoutMs({ AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS: invalid }),
      RangeError,
    );
  }
});

test("replays bounded timeout and classifies any late response", async () => {
  const timeoutFixture = await fixture("request-timeout");
  const scheduler = new ManualScheduler();
  const errors: string[] = [];
  const client = new AcpWireClient({
    requestTimeoutMs: Number(timeoutFixture.timeoutMs),
    scheduler,
    write: () => {},
    onProtocolError: (error) => errors.push(error.code),
  });
  const pending = client.request(String(timeoutFixture.method));
  scheduler.fireAll();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AcpWireTransportError && error.code === timeoutFixture.expectedError,
  );
  client.receive('{"jsonrpc":"2.0","id":1,"result":{"sessionId":"late"}}\n');
  assert.deepEqual(errors, ["late_response"]);
});

test("replays process exit as a typed transport failure", async () => {
  const exitFixture = await fixture("process-exit");
  const client = new AcpWireClient({ requestTimeoutMs: 15_000, write: () => {} });
  const pending = client.request(String(exitFixture.method));
  client.processExited(Number(exitFixture.exitCode), null);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof AcpWireTransportError &&
      error.code === exitFixture.expectedError &&
      error.details.exitCode === exitFixture.exitCode,
  );
});

test("keeps cancellation ambiguity in OpenCode validation policy", async () => {
  const cancellation = await fixture("cancellation-ambiguity");
  assert.equal(
    classifyOpenCodeCancellation({
      cancelResponse: cancellation.cancelResponse,
      providerAccepted: cancellation.providerAccepted as "unknown",
      terminalUpdate:
        typeof cancellation.terminalUpdate === "string"
          ? cancellation.terminalUpdate
          : undefined,
    }),
    cancellation.expected,
  );
});
