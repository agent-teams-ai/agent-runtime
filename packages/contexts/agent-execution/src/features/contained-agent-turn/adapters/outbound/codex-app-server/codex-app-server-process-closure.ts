import type { CustodiedProviderProcess } from "../host-custody/custodied-provider-process.js";
import {
  BoundedCodexJsonLineReader,
  CODEX_APP_SERVER_TIMEOUT as TIMEOUT,
} from "./codex-app-server-jsonl.js";

const deadlineAfter = (milliseconds: number): number => performance.now() + milliseconds;

const beforeDeadline = async <T>(promise: Promise<T>, deadline: number, message: string): Promise<T> => {
  const remaining = deadline - performance.now();
  if (remaining <= 0) {throw new Error(message);}
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), remaining);
  });
  try {return await Promise.race([promise, timeout]);}
  finally {if (timer !== undefined) {clearTimeout(timer);}}
};

export interface CodexStderrDrainEvidence {
  readonly status: "drained" | "read_failed";
}

export class CodexStderrReadError extends Error {
  public constructor() {
    super("Codex stderr could not be drained without ambiguity");
    this.name = "CodexStderrReadError";
  }
}

export const drainCodexStderr = async (process: CustodiedProviderProcess): Promise<CodexStderrDrainEvidence> => {
  try {
    for await (const bytes of process.stderr) {void bytes;}
    return { status: "drained" };
  } catch {
    return { status: "read_failed" };
  }
};

export const proveCodexOutputDrain = async (input: {
  readonly process: CustodiedProviderProcess;
  readonly reader: BoundedCodexJsonLineReader;
  readonly stderrDrain: Promise<CodexStderrDrainEvidence>;
  readonly timeoutMs: number;
}): Promise<void> => {
  const deadline = deadlineAfter(input.timeoutMs);
  await beforeDeadline(input.process.closeInput(), deadline, "Codex input close timed out");
  const afterTerminal = await input.reader.read(deadline);
  if (afterTerminal === TIMEOUT) {throw new Error("Codex stdout EOF timed out");}
  if (afterTerminal !== undefined) {throw new Error("Codex emitted a late or duplicate message after terminal observation");}
  const exit = await beforeDeadline(input.process.waitForExit(), deadline, "Codex process exit timed out");
  if (exit.code !== 0 || exit.signal !== null) {throw new Error("Codex process exit was not clean");}
  const stderr = await beforeDeadline(input.stderrDrain, deadline, "Codex stderr drain timed out");
  if (stderr.status !== "drained") {throw new CodexStderrReadError();}
};

export interface CodexNoStartEvidence {
  readonly proven: boolean;
  readonly stderrStatus: CodexStderrDrainEvidence["status"] | "unknown";
}

export const observeCodexStderrBounded = async (
  stderrDrain: Promise<CodexStderrDrainEvidence>,
  timeoutMs: number,
): Promise<CodexNoStartEvidence["stderrStatus"]> => {
  try {
    return (await beforeDeadline(stderrDrain, deadlineAfter(timeoutMs), "Codex stderr observation timed out")).status;
  } catch {return "unknown";}
};

export const proveCodexNoStart = async (input: {
  readonly process: CustodiedProviderProcess;
  readonly reader: BoundedCodexJsonLineReader;
  readonly stderrDrain: Promise<CodexStderrDrainEvidence>;
  readonly timeoutMs: number;
}): Promise<CodexNoStartEvidence> => {
  const deadline = deadlineAfter(input.timeoutMs);
  try {
    await beforeDeadline(input.process.closeInput(), deadline, "Codex input close timed out");
    if (await input.reader.read(deadline) !== undefined) {
      const stderrStatus = await observeCodexStderrBounded(input.stderrDrain, Math.max(1, deadline - performance.now()));
      return { proven: false, stderrStatus };
    }
    await beforeDeadline(input.process.waitForExit(), deadline, "Codex process exit timed out");
    const stderr = await beforeDeadline(input.stderrDrain, deadline, "Codex stderr drain timed out");
    return { proven: stderr.status === "drained", stderrStatus: stderr.status };
  } catch {
    const stderrStatus = await observeCodexStderrBounded(input.stderrDrain, Math.max(1, deadline - performance.now()));
    return { proven: false, stderrStatus };
  }
};

export const closeCodexInputBounded = async (
  process: CustodiedProviderProcess,
  timeoutMs: number,
): Promise<boolean> => {
  try {
    await beforeDeadline(process.closeInput(), deadlineAfter(timeoutMs), "Codex input close timed out");
    return true;
  } catch {return false;}
};
