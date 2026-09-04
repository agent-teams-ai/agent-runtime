import { parseStrictJson as parseSerializationStrictJson } from "../serialization/strict-json.js";
import { DockerEngineError } from "./docker-engine-error.js";

export const parseStrictJson = (bytes: Uint8Array): unknown => {
  try {return parseSerializationStrictJson(bytes);}
  catch {throw new DockerEngineError("malformed-response");}
};
