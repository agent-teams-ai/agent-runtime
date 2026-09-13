import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRuntimeHostDisposalIncompleteError,
  createAgentRuntimeHostDisposalLifecycle,
} from "../../dist/composition/agent-runtime-host-disposal.js";
import type { ContainedTurnAccessAuthority } from "../../dist/composition/contained-turn-access-authority.js";
import type { AuthorityBoundContainedTurnCapability } from "../../dist/composition/contained-turn-authority-capability.js";

const authority = () => ({
  authorityRevision: "runtime-access-authority:disposal-test",
  projectId: "project",
  tenantId: "tenant",
});

test("registration rejects malformed authority before retaining an operation", async () => {
  let getterCalls = 0;
  const invalidScopes: unknown[] = [
    { projectId: "project", tenantId: "tenant" },
    { ...authority(), authorityRevision: "invalid" },
    { ...authority(), authorityRevision: "runtime-access-authority:" },
    { ...authority(), authorityRevision: `runtime-access-authority:${"a".repeat(128)}` },
    { ...authority(), extra: true },
    { ...authority(), get authorityRevision() { getterCalls += 1; return authority().authorityRevision; } },
    new Proxy(authority(), { get() { throw new Error("must not read proxy"); } }),
  ];
  for (const scope of invalidScopes) {
    const unavailableCapability: AuthorityBoundContainedTurnCapability | undefined = undefined;
    const lifecycle = createAgentRuntimeHostDisposalLifecycle(unavailableCapability);
    assert.throws(() => lifecycle.registerContainedTurn({
      operationId: "operation",
      scope: scope as ContainedTurnAccessAuthority,
    }, {}), { name: "TypeError", message: "Contained-turn access authority is invalid" });
    await lifecycle.dispose();
  }
  assert.equal(getterCalls, 0);
});

test("disposal cancels with the immutable registered authority and retains nonterminal truth", async () => {
  const scope = authority();
  const expected = authority();
  let cancellations = 0;
  const capability: AuthorityBoundContainedTurnCapability = {
    authorityRevision: scope.authorityRevision,
    cancel: { async execute(input) {
      cancellations += 1;
      assert.deepEqual(input.authority, expected);
      assert.deepEqual(input.scope, expected);
      assert.ok(Object.isFrozen(input.authority));
      assert.ok(Object.isFrozen(input.scope));
      return { authority: input.authority, outcome: {
        status: "observed",
        turn: {
          operationId: "operation", commandId: "command", effectId: "effect",
          provider: "provider", revision: 1, output: [], status: "running",
        },
      } };
    } },
    observe: { async execute() { assert.fail("unexpected observation"); } },
    submit: { async execute() { assert.fail("unexpected submission"); } },
  };
  const lifecycle = createAgentRuntimeHostDisposalLifecycle(capability);
  const owner = {};
  lifecycle.registerContainedTurn({ operationId: "operation", scope }, owner);
  scope.authorityRevision = "runtime-access-authority:changed";
  scope.projectId = "changed-project";
  scope.tenantId = "changed-tenant";
  assert.throws(() => lifecycle.registerContainedTurn({
    operationId: "operation",
    scope: { projectId: "project", tenantId: "tenant" } as ContainedTurnAccessAuthority,
  }, owner), TypeError);
  await assert.rejects(lifecycle.dispose(), error => {
    assert.ok(error instanceof AgentRuntimeHostDisposalIncompleteError);
    assert.equal(error.status, "termination_unproven");
    assert.deepEqual(error.containedTurns, [{ operationId: "operation", status: "running" }]);
    return true;
  });
  assert.equal(cancellations, 1);
});

test("reserved authority in cancellation terminal proof cannot release operation ownership", async () => {
  const scope = authority();
  let cancellations = 0;
  const capability: AuthorityBoundContainedTurnCapability = {
    authorityRevision: scope.authorityRevision,
    cancel: { async execute(input) {
      cancellations += 1;
      return { authority: input.authority, outcome: {
        status: "observed",
        turn: {
          operationId: "operation", commandId: "command", effectId: "effect",
          provider: "provider", revision: 1, output: [], status: "cancelled",
          artifactManifestRef: "artifact", resultRef: scope.authorityRevision,
        },
      } };
    } },
    observe: { async execute() { assert.fail("unexpected observation"); } },
    submit: { async execute() { assert.fail("unexpected submission"); } },
  };
  const lifecycle = createAgentRuntimeHostDisposalLifecycle(capability);
  lifecycle.registerContainedTurn({ operationId: "operation", scope }, {});
  const disposal = lifecycle.dispose();
  await assert.rejects(disposal, error => {
    assert.ok(error instanceof AgentRuntimeHostDisposalIncompleteError);
    assert.equal(error.status, "termination_unproven");
    assert.deepEqual(error.containedTurns, [{ operationId: "operation", status: "contract_violation" }]);
    return true;
  });
  assert.equal(lifecycle.dispose(), disposal);
  assert.equal(cancellations, 1);
});
