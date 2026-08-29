import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AgentApp, ClientApp, methods } from "@agentclientprotocol/sdk";

import {
  attachOpenCodeClientToCustodiedStreams,
  createOpenCodeClientApp,
  observeOpenCodeCancellation,
  observeOpenCodeCapabilities,
  observeOpenCodeNegotiation,
  observeOpenCodePermission,
  observeOpenCodeToolUpdate,
  OpenCodeValidationError,
  requireOpenCodeCapability,
} from "../src/features/acp-compatibility/opencode-acp-validation.ts";

const fixtureRoot = new URL("../fixtures/acp-compatibility/", import.meta.url);

const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`${name}.json`, fixtureRoot), "utf8")) as Record<
    string,
    unknown
  >;

const frozenFixtureDigests: Readonly<Record<string, string>> = {
  "cancellation-ambiguity": "b526b6b371d0336da9a1cf4c692b628d9d132876293ff29bc0f9dfa9dc1e5bb1",
  "initialize-v1": "8c495983bef2d5cf89c1e33b39172e5afe508d2c6aa35f3bcbace216f71f3791",
  "opencode-1-18-25-normalized":
    "ebe3160c4421bfc2ee56e3944442988306b163a09920fa51c83d13d297b994c3",
  "permission-tool-callbacks":
    "f8950fd3f68a728e3646f16041621e7eb4ea862372549e36a66554948e2742a1",
  "session-capabilities": "e032cfa2cbc80abb0a9fafcfe14c7b7fb12b75291ba7c019ffe9a5574fa3671a",
  "unknown-unsupported-capabilities":
    "cf5a15e5aaa0b122c15d6aaac592fc82c05af1e03b07218a7372fad021274d43",
  "v2-to-v1-negotiation":
    "926111a1d200242506344547900d90a7a087fb546d4dc40be4fa08badc93f899",
};

const responseOf = (value: Record<string, unknown>): unknown => value.response;

test("locks relative, synthetic/normalized ACP fixture provenance", async () => {
  for (const [name, expected] of Object.entries(frozenFixtureDigests)) {
    const bytes = await readFile(new URL(`${name}.json`, fixtureRoot));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name);
    const parsed = JSON.parse(bytes.toString()) as Record<string, unknown>;
    assert.match(String(parsed.provenance), /synthetic|normalized/);
    assert.doesNotMatch(bytes.toString(), /\/var\/|\/home\/|credential|token/i);
  }
});

test("maps official ACP v1 baseline and presence-advertised session capabilities", async () => {
  const minimal = observeOpenCodeCapabilities(responseOf(await fixture("initialize-v1")));
  assert.deepEqual(minimal.session, {
    new: "baseline",
    prompt: "baseline",
    cancel: "baseline",
    update: "baseline",
    load: "unsupported",
    list: "unsupported",
    resume: "unsupported",
    close: "unsupported",
    delete: "unsupported",
    additionalDirectories: "unsupported",
    fork: "unsupported",
  });

  const advertised = observeOpenCodeCapabilities(
    responseOf(await fixture("session-capabilities")),
  );
  assert.equal(advertised.session.load, "supported");
  assert.equal(advertised.session.list, "supported");
  assert.equal(advertised.session.resume, "supported");
  assert.equal(advertised.session.close, "supported");
  assert.equal(advertised.session.fork, "deferred");
  requireOpenCodeCapability(advertised, "prompt");
  requireOpenCodeCapability(advertised, "close");
  assert.throws(
    () => requireOpenCodeCapability(advertised, "fork"),
    (error: unknown) =>
      error instanceof OpenCodeValidationError &&
      error.code === "unsupported_capability" &&
      error.details.deferred === true,
  );
});

test("keeps omitted, recognized-deferred, and unknown capabilities distinct", async () => {
  const observation = observeOpenCodeCapabilities(
    responseOf(await fixture("unknown-unsupported-capabilities")),
  );
  assert.equal(observation.session.close, "supported");
  assert.equal(observation.session.load, "unsupported");
  assert.equal(observation.session.list, "unsupported");
  assert.equal(observation.session.resume, "unsupported");
  assert.equal(observation.session.fork, "unsupported");
  assert.deepEqual(observation.officialDeferred, []);
  assert.deepEqual(observation.unknown, [
    "agentCapabilities/futureTopLevel",
    "sessionCapabilities/futureSessionOperation",
  ]);
});

test("applies non-null presence semantics to every modeled session capability", () => {
  const modeled = {
    additionalDirectories: "deferred",
    close: "supported",
    delete: "deferred",
    fork: "deferred",
    list: "supported",
    resume: "supported",
  } as const;

  for (const [capability, advertisedStatus] of Object.entries(modeled)) {
    for (const [value, expectedStatus] of [
      [{}, advertisedStatus],
      [null, "unsupported"],
      [undefined, "unsupported"],
    ] as const) {
      const sessionCapabilities =
        value === undefined ? {} : { [capability]: value };
      const observation = observeOpenCodeCapabilities({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities },
      });
      assert.equal(
        observation.session[capability as keyof typeof modeled],
        expectedStatus,
        `${capability}:${String(value)}`,
      );
    }
  }
});

test("keeps loadSession boolean mapping separate from official deferred and extensions", () => {
  for (const [loadSession, expected] of [
    [true, "supported"],
    [false, "unsupported"],
    [undefined, "unsupported"],
  ] as const) {
    const agentCapabilities =
      loadSession === undefined ? {} : { loadSession };
    assert.equal(
      observeOpenCodeCapabilities({ protocolVersion: 1, agentCapabilities }).session.load,
      expected,
    );
  }

  const observation = observeOpenCodeCapabilities({
    protocolVersion: 1,
    agentCapabilities: {
      auth: {},
      providers: {},
      sessionCapabilities: { delete: {} },
      promptCapabilities: { futurePrompt: {} },
      mcpCapabilities: { acp: true, futureMcp: {} },
    },
  });
  assert.deepEqual(observation.officialDeferred, [
    "agentCapabilities/auth",
    "agentCapabilities/providers",
    "mcpCapabilities/acp",
    "sessionCapabilities/delete",
  ]);
  assert.deepEqual(observation.unknown, [
    "mcpCapabilities/futureMcp",
    "promptCapabilities/futurePrompt",
  ]);
});

test("classifies unstable MCP-over-ACP only when explicitly true", () => {
  for (const [acp, expected] of [
    [true, ["mcpCapabilities/acp"]],
    [false, []],
    [undefined, []],
  ] as const) {
    const mcpCapabilities = acp === undefined ? {} : { acp };
    const observation = observeOpenCodeCapabilities({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities },
    });
    assert.deepEqual(observation.officialDeferred, expected, String(acp));
  }

  for (const acp of [null, "true"] as const) {
    assert.throws(
      () =>
        observeOpenCodeCapabilities({
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { acp } },
        }),
      (error: unknown) =>
        error instanceof OpenCodeValidationError &&
        error.code === "malformed_observation" &&
        error.details.kind === "initialize_response",
      String(acp),
    );
  }
});

test("accepts only an explicit requested-v2/negotiated-v1 observation", async () => {
  const downgrade = await fixture("v2-to-v1-negotiation");
  assert.equal(
    observeOpenCodeNegotiation(Number(downgrade.requestedVersion), downgrade.response)
      .protocolVersion,
    1,
  );
  assert.throws(
    () => observeOpenCodeNegotiation(2, { protocolVersion: 2 }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "unsupported_protocol",
  );
  assert.throws(
    () => observeOpenCodeNegotiation(3, { protocolVersion: 1 }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
});

test("rejects malformed values against the official SDK ACP v1 schema", () => {
  for (const malformed of [
    { protocolVersion: "1" },
    { protocolVersion: 1, agentCapabilities: { loadSession: "yes" } },
    { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: true } } },
  ]) {
    assert.throws(
      () => observeOpenCodeCapabilities(malformed),
      (error: unknown) =>
        error instanceof OpenCodeValidationError && error.code === "malformed_observation",
    );
  }
  assert.throws(
    () =>
      observeOpenCodePermission("session-1", {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
      }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
  assert.throws(
    () =>
      observeOpenCodeToolUpdate("session-1", {
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call", title: "missing-id" },
      }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
});

test("bounds provider, session, tool, and capability identifiers before retention", async () => {
  const policy = await fixture("permission-tool-callbacks");
  assert.throws(
    () =>
      observeOpenCodeCapabilities({
        protocolVersion: 1,
        agentInfo: { name: "x".repeat(129), version: "fixture-v1" },
      }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
  assert.throws(
    () =>
      observeOpenCodeCapabilities({
        protocolVersion: 1,
        agentCapabilities: { [`x${"y".repeat(64)}`]: {} },
      }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
  assert.throws(
    () => observeOpenCodePermission("x".repeat(129), policy.permission),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
});

test("binds permission and tool observations to the active session and never auto-approves", async () => {
  const policy = await fixture("permission-tool-callbacks");
  const sessionId = String(policy.activeSessionId);
  const permission = observeOpenCodePermission(sessionId, policy.permission);
  const tool = observeOpenCodeToolUpdate(sessionId, policy.toolUpdate);
  assert.deepEqual(permission, {
    kind: "permission",
    sessionId,
    toolCallId: "tool-1",
    autoApproved: false,
    disposition: "deferred_to_runtime_authority",
  });
  assert.equal(tool?.autoApproved, false);

  for (const value of [policy.permission, policy.toolUpdate]) {
    const substituted = structuredClone(value) as Record<string, unknown>;
    substituted.sessionId = "session-substitution";
    assert.throws(
      () =>
        "options" in substituted
          ? observeOpenCodePermission(sessionId, substituted)
          : observeOpenCodeToolUpdate(sessionId, substituted),
      (error: unknown) =>
        error instanceof OpenCodeValidationError &&
        error.code === "malformed_observation" &&
        error.details.kind === "active_session_mismatch",
    );
  }
});

test("classifies cancellation only from session-bound, non-contradictory evidence", async () => {
  const cancellation = await fixture("cancellation-ambiguity");
  const activeSessionId = String(cancellation.activeSessionId);
  const cancel = cancellation.cancel;
  const acceptedValues = [false, true, "unknown"] as const;
  const terminalValues = [null, "cancelled", "end_turn"] as const;

  for (const explicitNoStartProof of [false, true]) {
    for (const providerAccepted of acceptedValues) {
      for (const terminalStopReason of terminalValues) {
        const actual = observeOpenCodeCancellation(activeSessionId, {
          cancel,
          explicitNoStartProof,
          providerAccepted,
          terminalStopReason,
        });
        const expected =
          explicitNoStartProof && providerAccepted === false && terminalStopReason === null
            ? "cancelled_before_acceptance"
            : !explicitNoStartProof &&
                providerAccepted !== false &&
                terminalStopReason === "end_turn"
              ? "completed_before_cancel"
              : !explicitNoStartProof &&
                  providerAccepted === true &&
                  terminalStopReason === "cancelled"
                ? "cancelled_after_acceptance"
                : "ambiguous_requires_reconciliation";
        assert.equal(actual, expected);
      }
    }
  }

  assert.throws(
    () =>
      observeOpenCodeCancellation(activeSessionId, {
        cancel: { sessionId: "other-session" },
        explicitNoStartProof: true,
        providerAccepted: false,
        terminalStopReason: null,
      }),
    (error: unknown) =>
      error instanceof OpenCodeValidationError && error.code === "malformed_observation",
  );
});

test("returns detached, deeply frozen policy observations", async () => {
  const source = responseOf(await fixture("unknown-unsupported-capabilities")) as Record<
    string,
    unknown
  >;
  const observation = observeOpenCodeCapabilities(source);
  const capabilities = source.agentCapabilities as Record<string, unknown>;
  capabilities.futureMutation = {};
  assert.ok(Object.isFrozen(observation));
  assert.ok(Object.isFrozen(observation.session));
  assert.ok(Object.isFrozen(observation.prompt));
  assert.ok(Object.isFrozen(observation.mcp));
  assert.ok(Object.isFrozen(observation.officialDeferred));
  assert.ok(Object.isFrozen(observation.unknown));
  assert.doesNotMatch(JSON.stringify(observation), /futureMutation/);
});

test("retains only the supplied normalized OpenCode 1.18.25 observation", async () => {
  const retained = await fixture("opencode-1-18-25-normalized");
  const observation = observeOpenCodeCapabilities(retained.response);
  assert.equal(observation.providerVersion, "1.18.25");
  assert.deepEqual(observation.prompt, {
    audio: false,
    embeddedContext: true,
    image: true,
  });
  assert.deepEqual(observation.mcp, { http: true, sse: true });
  assert.equal(observation.session.fork, "deferred");
  assert.equal(
    retained.fixedPromptOutputDigestSha256,
    "dc5d87f627deedda40c795c8435536e04764761fee5dbe2fb29e7e4e90484e74",
  );
  assert.equal(retained.costUsd, 0);
  assert.equal(retained.permissionOrToolRequestObserved, false);
});

test("exposes only the thin official-SDK seam for already bounded Host Custody streams", async () => {
  assert.ok(createOpenCodeClientApp({ activeSessionId: "session-1" }) instanceof ClientApp);
  const fromAgent = new ReadableStream<Uint8Array>();
  const toAgent = new WritableStream<Uint8Array>();
  const connection = attachOpenCodeClientToCustodiedStreams(
    { boundedByHostCustody: true, fromAgent, toAgent },
    { activeSessionId: "session-1" },
  );
  connection.close();
  await connection.closed;
});

test("routes official SDK callbacks in memory and closes the connection", async () => {
  const events: string[] = [];
  const agent = new AgentApp({ name: "characterization-agent" }).onRequest(
    methods.agent.session.prompt,
    async ({ client, params }) => {
      const permission = await client.request(methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "tool-1",
          title: "Characterization tool",
          kind: "execute",
          status: "pending",
          content: [],
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      events.push(`permission:${permission.outcome.outcome}`);
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
        },
      });
      return { stopReason: "end_turn" };
    },
  );
  const connection = createOpenCodeClientApp({
    activeSessionId: "session-1",
    onPermission: (observation) => events.push(`request:${observation.toolCallId}`),
    onTool: (observation) => events.push(`update:${observation.toolCallId}`),
  }).connect(agent);

  assert.deepEqual(
    await connection.agent.request(methods.agent.session.prompt, {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "route callbacks" }],
    }),
    { stopReason: "end_turn" },
  );
  assert.deepEqual(events, [
    "request:tool-1",
    "permission:cancelled",
    "update:tool-1",
  ]);
  connection.close();
  await connection.closed;
});

test("keeps documentation at characterization and custody boundaries", async () => {
  const document = await readFile(
    new URL("../../../docs/spikes/opencode-acp-1-18-25-contract-validation.md", import.meta.url),
    "utf8",
  );
  assert.match(document, /synthetic\/normalized/i);
  assert.match(document, /no raw ACP transcript/i);
  assert.match(document, /Host Custody.*byte.*line.*bound/is);
  assert.match(document, /official SDK/i);
  assert.doesNotMatch(document, /closes only the plan-authorized/i);
  assert.doesNotMatch(document, /product E2E (?:passed|complete|closed)/i);
});
