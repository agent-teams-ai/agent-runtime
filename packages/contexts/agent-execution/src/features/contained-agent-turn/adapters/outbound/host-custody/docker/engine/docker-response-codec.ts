import type {IncomingMessage} from "node:http";
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

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

interface ResponseFraming {
  readonly contentLength: number | undefined;
  readonly contentType: string;
}

export const validateResponseHeaders = (response: IncomingMessage): ResponseFraming => {
  if (response.rawHeaders.length % 2 !== 0) {throw new DockerEngineError("protocol-violation");}
  const seen = new Set<string>();
  let contentType = "";
  let contentLength: number | undefined;
  let chunked = false;
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const rawName = response.rawHeaders[index];
    const rawValue = response.rawHeaders[index + 1];
    if (rawName === undefined || rawValue === undefined || !HEADER_NAME.test(rawName) || /[\r\n]/u.test(rawValue)) {
      throw new DockerEngineError("protocol-violation");
    }
    const name = rawName.toLowerCase();
    if (seen.has(name)) {throw new DockerEngineError("protocol-violation");}
    seen.add(name);
    if (name === "content-type") {contentType = rawValue;}
    if (name === "content-length") {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(rawValue)) {throw new DockerEngineError("protocol-violation");}
      const parsed = Number(rawValue);
      if (!Number.isSafeInteger(parsed)) {throw new DockerEngineError("protocol-violation");}
      contentLength = parsed;
    }
    if (name === "transfer-encoding") {
      if (rawValue.trim().toLowerCase() !== "chunked") {throw new DockerEngineError("protocol-violation");}
      chunked = true;
    }
  }
  const bodyForbidden = response.statusCode === 204 || response.statusCode === 304;
  if (bodyForbidden) {
    if (chunked || (contentLength !== undefined && contentLength !== 0)) {
      throw new DockerEngineError("protocol-violation");
    }
  } else if ((contentLength === undefined) === !chunked) {
    throw new DockerEngineError("protocol-violation");
  }
  return { contentLength, contentType };
};
