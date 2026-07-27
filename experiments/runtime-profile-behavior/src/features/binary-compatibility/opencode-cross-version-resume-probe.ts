import { runCommand } from "../process-execution/run-command.ts";

const startExecutable = process.argv[2];
const resumeExecutable = process.argv[3];
const workspace = process.argv[4];
if (
  startExecutable === undefined ||
  resumeExecutable === undefined ||
  workspace === undefined
) {
  throw new Error("Expected start executable, resume executable and workspace");
}

type OpenCodeEvent = {
  readonly type?: string;
  readonly sessionID?: string;
  readonly part?: {
    readonly text?: string;
  };
};

const parseEvents = (stdout: string): readonly OpenCodeEvent[] =>
  stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as OpenCodeEvent];
      } catch {
        return [];
      }
    });

const summarize = (stdout: string) => {
  const events = parseEvents(stdout);
  const sessionId = events.find(
    (event) => typeof event.sessionID === "string",
  )?.sessionID;
  return {
    sessionId,
    text: events
      .filter((event) => event.type === "text")
      .map((event) => event.part?.text ?? "")
      .join(""),
    eventTypes: [...new Set(events.map((event) => event.type))].filter(
      (type) => type !== undefined,
    ),
  };
};

const startMarker = "runtime-profile-cross-version-start-ok";
const start = await runCommand(startExecutable, {
  args: [
    "run",
    "--pure",
    "--format",
    "json",
    "--model",
    "opencode/big-pickle",
    `Reply with exactly ${startMarker}. Do not use tools.`,
  ],
  cwd: workspace,
  env: process.env,
  timeoutMs: 60_000,
});
const startSummary = summarize(start.stdout);

const resumeMarker = "runtime-profile-cross-version-resume-ok";
const resumed =
  startSummary.sessionId === undefined
    ? undefined
    : await runCommand(resumeExecutable, {
        args: [
          "run",
          "--pure",
          "--format",
          "json",
          "--session",
          startSummary.sessionId,
          "--model",
          "opencode/big-pickle",
          `Reply with exactly ${resumeMarker}. Do not use tools.`,
        ],
        cwd: workspace,
        env: process.env,
        timeoutMs: 60_000,
      });
const resumeSummary = summarize(resumed?.stdout ?? "");

process.stdout.write(
  `${JSON.stringify(
    {
      start: {
        exitCode: start.exitCode,
        stderr: start.stderr.slice(0, 2_000),
        ...startSummary,
      },
      resumed: {
        exitCode: resumed?.exitCode,
        stderr: resumed?.stderr.slice(0, 2_000),
        ...resumeSummary,
      },
      sameSession:
        startSummary.sessionId !== undefined &&
        startSummary.sessionId === resumeSummary.sessionId,
      startedSuccessfully:
        start.exitCode === 0 &&
        startSummary.text.trim() === startMarker,
      resumedSuccessfully:
        resumed?.exitCode === 0 &&
        resumeSummary.text.trim() === resumeMarker,
    },
    null,
    2,
  )}\n`,
);
