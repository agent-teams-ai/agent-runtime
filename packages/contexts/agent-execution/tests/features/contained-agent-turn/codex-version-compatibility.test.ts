import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAppServerPermissionBoundary } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import { admitCodexThreadItem } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-thread-item.js";
import { validateAndNormalizeCodexThreadItem } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-item-schema.js";
import { codexAppServerTupleForBinaryRevision } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";

const fixture = (t: TestContext) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ar-codex-version-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const codexHome = join(root, "private-home"); const workspaceRef = join(root, "test-workspace");
  mkdirSync(codexHome, { mode: 0o700 }); mkdirSync(workspaceRef, { mode: 0o700 });
  return createCodexAppServerPermissionBoundary({ codexHome, workspaceRef, intentMode: "analysis" });
};

test("0.153.4 normalizes absent or null questions without changing plain agent messages", t => {
  const boundary = fixture(t);
  for (const optional of [{}, { questions: null }]) {
    const result = admitCodexThreadItem({ id: "message:new-version", type: "agentMessage", text: "done", ...optional }, "analysis", boundary);
    assert.equal(result.item.questions, null);
    assert.equal(result.item.text, "done");
  }
});

test("0.153.4 question and function-output wire shapes do not enable additional V1 interactions", t => {
  const boundary = fixture(t);
  const items = [
    { id: "question:empty", type: "agentMessage", text: "choose", questions: [] },
    { id: "question:pending", type: "agentMessage", text: "choose", questions: [{ title: "Choose one", options: ["A", "B"] }] },
    { id: "output:new", type: "functionCallOutput", name: "unsupported", output: "synthetic" },
  ];
  for (const item of items) {
    assert.notEqual(validateAndNormalizeCodexThreadItem(item), undefined);
    for (const mode of ["analysis", "workspace-write"] as const) {
      assert.throws(() => admitCodexThreadItem(item, mode, boundary), /did not match an admitted/u);
    }
  }
});

test("0.153.4 selection rejects retained 0.150.1 binary identities", () => {
  for (const platform of ["linux-x64", "darwin-arm64"]) {
    assert.throws(() => codexAppServerTupleForBinaryRevision(`@openai/codex:0.150.1+${platform}`));
    assert.equal(codexAppServerTupleForBinaryRevision(`@openai/codex:0.153.4+${platform}`).version, "0.153.4");
  }
});
