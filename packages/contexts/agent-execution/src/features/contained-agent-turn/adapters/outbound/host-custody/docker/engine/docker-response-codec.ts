import { DockerEngineError } from "./docker-engine-error.js";

const SHA256 = /^[a-f0-9]{64}$/u;

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DockerEngineError("malformed-response");
  }
  return value as Record<string, unknown>;
};

const exactObject = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const decoded = object(value);
  const observed = Object.keys(decoded).toSorted();
  const expected = [...keys].toSorted();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    throw new DockerEngineError("malformed-response");
  }
  return decoded;
};

const string = (value: unknown): string => {
  if (typeof value !== "string") {throw new DockerEngineError("malformed-response");}
  return value;
};

const safeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DockerEngineError("malformed-response");
  }
  return value;
};

export const decodeCreateId = (value: unknown): string => {
  const response = exactObject(value, ["Id", "Warnings"]);
  const id = string(response.Id);
  if (!Array.isArray(response.Warnings) || response.Warnings.some(warning => typeof warning !== "string") ||
      !SHA256.test(id)) {throw new DockerEngineError("malformed-response");}
  return id;
};

export const decodeErrorResponse = (value: unknown): void => {
  const message = string(exactObject(value, ["message"]).message);
  if (message.length === 0 || message.length > 4096) {throw new DockerEngineError("malformed-response");}
};

export const decodeWaitExitCode = (value: unknown): number => {
  const response = object(value);
  const keys = Object.keys(response).toSorted();
  const successShape = keys.length === 1 && keys[0] === "StatusCode";
  const errorShape = keys.length === 2 && keys[0] === "Error" && keys[1] === "StatusCode";
  if (!successShape && !errorShape) {throw new DockerEngineError("malformed-response");}
  if (errorShape && response.Error !== null) {
    const message = string(exactObject(response.Error, ["Message"]).Message);
    if (message !== "") {throw new DockerEngineError("request-rejected");}
  }
  return safeInteger(response.StatusCode);
};
