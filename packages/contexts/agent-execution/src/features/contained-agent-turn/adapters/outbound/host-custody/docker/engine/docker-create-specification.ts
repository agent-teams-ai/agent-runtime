import { containerName, encodeCreateRequest } from "./docker-create-request.js";
import { canonicalJsonSha256 } from "./docker-canonical-json.js";
import type { DockerContainerCreate, DockerEnginePolicy } from "./docker-engine-port.js";

export const createSpecificationSha256 = (
  input: DockerContainerCreate,
  policy: DockerEnginePolicy,
): string => {
  const request = encodeCreateRequest(input, policy);
  return canonicalJsonSha256({ Name: containerName(input.operationNonceSha256), Request: request });
};
