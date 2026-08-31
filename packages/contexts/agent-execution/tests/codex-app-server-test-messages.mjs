export const generatedTurn = (id, status, error = null, items = [], itemsView = "full") => ({
  completedAt: status === "inProgress" ? null : 1,
  durationMs: status === "inProgress" ? null : 1,
  error,
  id,
  items,
  itemsView,
  startedAt: 1,
  status,
});

export const agentMessage = (id, text) => ({
  delivery: null,
  id,
  memoryCitation: null,
  phase: null,
  text,
  type: "agentMessage",
});

export const commandExecution = (id, overrides = {}) => ({
  aggregatedOutput: null,
  command: "printf exact",
  commandActions: [],
  cwd: "/synthetic/workspace",
  durationMs: null,
  exitCode: null,
  id,
  pluginId: null,
  processId: null,
  scriptPath: null,
  source: "agent",
  status: "inProgress",
  type: "commandExecution",
  ...overrides,
});

export const fileChange = (id, overrides = {}) => ({
  changes: [],
  id,
  status: "inProgress",
  type: "fileChange",
  ...overrides,
});

export const emitTurnStarted = (target, turnId) => {
  target.emit({ method: "turn/started", params: { threadId: "thread:test", turn: generatedTurn(turnId, "inProgress") } });
};

export const emitAgentStarted = (target, turnId, itemId) => {
  target.emit({
    method: "item/started",
    params: { item: agentMessage(itemId, ""), startedAtMs: 1, threadId: "thread:test", turnId },
  });
};

export const emitAgentCompleted = (target, turnId, itemId, text) => {
  target.emit({
    method: "item/completed",
    params: { completedAtMs: 2, item: agentMessage(itemId, text), threadId: "thread:test", turnId },
  });
};
