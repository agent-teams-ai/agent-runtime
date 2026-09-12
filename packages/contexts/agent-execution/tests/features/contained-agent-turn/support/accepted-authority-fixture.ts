import assert from "node:assert/strict";
import { submitContainedTurn } from "../../../../dist/features/contained-agent-turn/application/contained-turn-submission.js";
import { createDependencies } from "./contained-agent-turn-fixture.ts";

/** Captures a genuine acknowledged synthetic AE handoff for direct legacy ACL mapping tests. */
export const acceptedAuthorityFixture = async () => {
  const { dependencies } = createDependencies();
  let captured: Parameters<typeof dependencies.providerAccess.consumeForDispatch>[0] | undefined;
  await submitContainedTurn({
    ...dependencies,
    providerAccess: {
      ...dependencies.providerAccess,
      consumeForDispatch: async input => {
        captured = input;
        return dependencies.providerAccess.consumeForDispatch(input);
      },
    },
  }, {
    commandId: "command:acl-handoff", expectedProvider: "codex",
    intent: { mode: "analysis", prompt: "Synthetic ACL mapping" },
    scope: { projectId: "project:one", tenantId: "tenant:one" },
  });
  assert.ok(captured);
  return captured;
};
