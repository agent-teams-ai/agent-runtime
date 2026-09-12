import assert from "node:assert/strict";

import type { PostgresContainedTurnOperationStore } from "../../../../dist/features/contained-agent-turn/adapters/outbound/postgres/postgres-contained-turn-operation-store.js";
import { containedTurnPreparationToken } from "../../../../dist/features/contained-agent-turn/application/contained-turn-preparation-cleanup.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { mutateContainedTurnOperation } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-kernel.js";
import { operationAuthority, operationForProject } from "../postgres-contained-turn-test-helpers.ts";

type Recovery = Awaited<ReturnType<PostgresContainedTurnOperationStore["listDispatchPreparations"]>>;
type Scope = Recovery[number]["operation"]["scope"];
const ordered = (rows: Recovery) => rows.toSorted((left, right) =>
  left.operation.operationId.localeCompare(right.operation.operationId));

export const seedScopedPreparations = async (store: PostgresContainedTurnOperationStore, scope: Scope) => {
  const scopes = [scope, { ...scope, projectId: "project:preparation-other" },
    { ...scope, tenantId: "tenant:preparation-other" }];
  const expected: Recovery[number][] = [];
  for (const [index, selected] of scopes.entries()) {
    for (const kind of ["active", "cleanup_pending"] as const) {
      const suffix = `fresh-preparation-${String(index)}-${kind}`;
      const initial = operationForProject(selected.projectId, suffix,
        containedTurnIdentity("command", `command:preparation:${kind}`), selected.tenantId);
      assert.equal((await store.accept(initial, operationAuthority(initial))).kind, "accepted");
      const workspaceId = containedTurnIdentity("workspace", `workspace:${suffix}`);
      const operation = mutateContainedTurnOperation(initial, { kind: "bind_workspace", workspaceId });
      assert.equal((await store.commit({ authority: operationAuthority(initial), candidate: operation,
        expectedRevision: initial.revision })).kind, "applied");
      const reservation = await store.prepareDispatch({ authority: operationAuthority(operation), operation });
      const preparationToken = containedTurnPreparationToken({ attemptId: reservation.attemptId,
        custodyId: reservation.custodyId, operationId: operation.operationId });
      const active = {
        attemptId: reservation.attemptId, custodyId: reservation.custodyId, kind: "active" as const,
        operationCutoffRevision: operation.operationCutoff.revision, operationId: operation.operationId,
        preparationToken, preparedOperationRevision: operation.revision,
        providerAccessGrantRequestId: null, runtimeSecurityGrantRequestId: null, workspaceId,
      };
      if (kind === "active") {expected.push({ operation, preparation: active });}
      else {
        const retired = await store.retireDispatchPreparation({
          authority: operationAuthority(operation), preparationToken, reason: "reconciliation",
          expectedOperationCutoffRevision: operation.operationCutoff.revision,
          expectedOperationRevision: operation.revision,
        });
        assert.equal(retired.kind, "retired");
        if (retired.kind !== "retired") {throw new Error("missing cleanup preparation");}
        expected.push({ operation, preparation: retired.preparation });
      }
    }
  }
  await verifyScopedPreparations(store, expected);
  return expected;
};

export const verifyScopedPreparations = async (store: PostgresContainedTurnOperationStore, expected: Recovery) => {
  for (const { operation } of expected) {
    const scope = operation.scope;
    const owned = expected.filter(row => row.operation.scope.projectId === scope.projectId &&
      row.operation.scope.tenantId === scope.tenantId);
    assert.equal(owned.length, 2);
    // Exact positive sets catch empty implementations and either missing scope predicate.
    assert.deepEqual(ordered(await store.listDispatchPreparations({ scope })), ordered(owned));
    for (const kind of ["active", "cleanup_pending"] as const) {
      assert.deepEqual(await store.listDispatchPreparations({ scope, kinds: [kind] }),
        owned.filter(row => row.preparation.kind === kind));
    }
    for (const foreign of expected.filter(row => !owned.includes(row))) {
      assert.equal(await store.read({ operationId: foreign.operation.operationId, scope }), undefined);
    }
  }
};
