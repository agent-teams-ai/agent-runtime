import { DockerEngineError } from "./docker-engine-error.js";
import type { DockerContainerStateFacts } from "./docker-engine-port.js";

const ZERO_TIMESTAMP = "0001-01-01T00:00:00Z";
const DOCKER_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const STATUSES = new Set(["created", "dead", "exited", "paused", "removing", "restarting", "running"]);
const STATE_FIELDS = Object.freeze([
  "Dead", "Error", "ExitCode", "FinishedAt", "Health", "OOMKilled", "Paused", "Pid", "Restarting", "Running",
  "StartedAt", "Status",
]);
const REQUIRED_STATE_FIELDS = Object.freeze([
  "Dead", "Error", "ExitCode", "FinishedAt", "OOMKilled", "Paused", "Pid", "Restarting", "Running",
  "StartedAt", "Status",
]);

interface TimestampFacts {
  readonly nanoseconds: bigint;
  readonly source: string;
  readonly zero: boolean;
}

const malformed = (): never => {throw new DockerEngineError("malformed-response");};

const stateRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {return malformed();}
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  if (keys.some(key => !STATE_FIELDS.includes(key)) || REQUIRED_STATE_FIELDS.some(key => !Object.hasOwn(state, key))) {
    return malformed();
  }
  return state;
};

const stringField = (value: unknown): string => typeof value === "string" ? value : malformed();

const booleanField = (value: unknown): boolean => typeof value === "boolean" ? value : malformed();

const integerField = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : malformed();

const timestamp = (value: unknown): TimestampFacts => {
  const source = stringField(value);
  const match = DOCKER_TIMESTAMP.exec(source);
  if (match === null) {return malformed();}
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  if ([year < 1, month < 1, month > 12, day < 1, day > 31, hour > 23, minute > 59, second > 59].some(Boolean)) {
    return malformed();
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if ([
    date.getUTCFullYear() !== year,
    date.getUTCMonth() !== month - 1,
    date.getUTCDate() !== day,
    date.getUTCHours() !== hour,
    date.getUTCMinutes() !== minute,
    date.getUTCSeconds() !== second,
  ].some(Boolean)) {return malformed();}
  const fraction = (match[7] ?? "").padEnd(9, "0");
  return {
    nanoseconds: (BigInt(Math.trunc(date.getTime() / 1000)) * 1_000_000_000n) + BigInt(fraction || "0"),
    source,
    zero: source === ZERO_TIMESTAMP,
  };
};

const boundedFacts = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
  error: string,
): boolean => [
  state.hostPid >= 0,
  state.hostPid <= 2_147_483_647,
  state.exitCode >= 0,
  state.exitCode <= 255,
  error.length <= 4_096,
  started.zero || Number(started.source.slice(0, 4)) >= 1970,
  finished.zero || Number(finished.source.slice(0, 4)) >= 1970,
].every(Boolean);

const createdTruth = (state: DockerContainerStateFacts, started: TimestampFacts, finished: TimestampFacts): boolean => [
  !state.running, !state.paused, !state.restarting, !state.dead, state.hostPid === 0, state.exitCode === 0,
  started.zero, finished.zero,
].every(Boolean);

const activeTruth = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
): boolean => [
  state.running, state.paused === (state.status === "paused"), !state.restarting, !state.dead, state.hostPid > 0,
  !started.zero, finished.zero, state.exitCode === 0,
].every(Boolean);

const restartingTruth = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
): boolean => [
  state.running, !state.paused, state.restarting, !state.dead, state.hostPid === 0, !started.zero, !finished.zero,
  finished.nanoseconds >= started.nanoseconds,
].every(Boolean);

const terminalTruth = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
): boolean => [
  !state.running, !state.paused, !state.restarting, state.dead === (state.status === "dead"), state.hostPid === 0,
  !started.zero, !finished.zero, finished.nanoseconds >= started.nanoseconds,
].every(Boolean);

const removingTruth = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
): boolean => {
  const timestamps = started.zero
    ? finished.zero && state.exitCode === 0
    : !finished.zero && finished.nanoseconds >= started.nanoseconds;
  return [!state.running, !state.paused, !state.restarting, !state.dead, state.hostPid === 0, timestamps].every(Boolean);
};

const coherentState = (
  state: DockerContainerStateFacts,
  started: TimestampFacts,
  finished: TimestampFacts,
): boolean => {
  switch (state.status) {
    case "created": return createdTruth(state, started, finished);
    case "running":
    case "paused": return activeTruth(state, started, finished);
    case "restarting": return restartingTruth(state, started, finished);
    case "exited":
    case "dead": return terminalTruth(state, started, finished);
    case "removing": return removingTruth(state, started, finished);
  }
};

export const decodeDockerContainerState = (value: unknown): DockerContainerStateFacts => {
  const source = stateRecord(value);
  const status = stringField(source.Status);
  if (!STATUSES.has(status)) {return malformed();}
  const error = stringField(source.Error);
  const started = timestamp(source.StartedAt);
  const finished = timestamp(source.FinishedAt);
  const state: DockerContainerStateFacts = {
    dead: booleanField(source.Dead),
    errorPresent: error.length > 0,
    exitCode: integerField(source.ExitCode),
    finishedAt: finished.source,
    hostPid: integerField(source.Pid),
    oomKilled: booleanField(source.OOMKilled),
    paused: booleanField(source.Paused),
    restarting: booleanField(source.Restarting),
    running: booleanField(source.Running),
    startedAt: started.source,
    status: status as DockerContainerStateFacts["status"],
  };
  if (!boundedFacts(state, started, finished, error) || !coherentState(state, started, finished)) {return malformed();}
  return state;
};
