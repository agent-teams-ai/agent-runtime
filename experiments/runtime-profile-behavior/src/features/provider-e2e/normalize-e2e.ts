import type { CommandResult } from "../../model.ts";

const normalizedResult = (
  result: CommandResult,
  value: unknown,
): CommandResult => ({
  ...result,
  stdout: `${JSON.stringify(value, null, 2)}\n`,
});

export const normalizeClaudeE2e = (
  result: CommandResult,
): CommandResult => {
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return normalizedResult(result, {
      subtype: parsed.subtype,
      isError: parsed.is_error,
      result: parsed.result,
      numTurns: parsed.num_turns,
      totalCostUsd: parsed.total_cost_usd,
    });
  } catch {
    return result;
  }
};

interface JsonLine {
  readonly type?: string;
  readonly thread_id?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
  readonly usage?: unknown;
  readonly error?: unknown;
}

const parseJsonLines = (value: string): readonly JsonLine[] =>
  value
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonLine];
      } catch {
        return [];
      }
    });

export const normalizeCodexE2e = (
  result: CommandResult,
): CommandResult => {
  const events = parseJsonLines(result.stdout);
  const thread = events.find((event) => event.type === "thread.started");
  const message = events.find(
    (event) =>
      event.type === "item.completed" &&
      event.item?.type === "agent_message",
  );
  const completed = events.find((event) => event.type === "turn.completed");
  if (events.length === 0) {
    return result;
  }
  return normalizedResult(result, {
    threadIdPresent: typeof thread?.thread_id === "string",
    finalText: message?.item?.text,
    usagePresent: completed?.usage !== undefined,
    eventTypes: [...new Set(events.map((event) => event.type))].filter(
      (type) => type !== undefined,
    ),
  });
};

const collectText = (value: unknown, output: string[]): void => {
  if (typeof value === "string") {
    if (value.includes("runtime-profile-spike-ok")) {
      output.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectText(item, output));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((item) => collectText(item, output));
  }
};

interface ErrorDiagnostic {
  readonly field: string;
  readonly value: string | number;
}

const collectErrorDiagnostics = (
  value: unknown,
  output: ErrorDiagnostic[],
  depth = 0,
): void => {
  if (depth > 6 || output.length >= 20 || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectErrorDiagnostics(item, output, depth + 1),
    );
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  for (const [field, item] of Object.entries(value)) {
    if (
      ["name", "message", "code", "status", "statusCode"].includes(field) &&
      (typeof item === "string" || typeof item === "number")
    ) {
      output.push({
        field,
        value: typeof item === "string" ? item.slice(0, 1_000) : item,
      });
    } else {
      collectErrorDiagnostics(item, output, depth + 1);
    }
  }
};

export const normalizeOpenCodeE2e = (
  result: CommandResult,
): CommandResult => {
  const events = parseJsonLines(result.stdout);
  const texts: string[] = [];
  events.forEach((event) => collectText(event, texts));
  const errors: ErrorDiagnostic[] = [];
  events
    .filter((event) => event.type === "error")
    .forEach((event) => collectErrorDiagnostics(event.error, errors));
  if (events.length === 0) {
    return result;
  }
  return normalizedResult(result, {
    markerObserved: texts.some((text) =>
      text.includes("runtime-profile-spike-ok"),
    ),
    eventTypes: [...new Set(events.map((event) => event.type))].filter(
      (type) => type !== undefined,
    ),
    errors,
  });
};
