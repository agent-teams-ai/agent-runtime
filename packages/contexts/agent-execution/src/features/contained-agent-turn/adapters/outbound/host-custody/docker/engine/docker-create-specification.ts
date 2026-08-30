import { createHash } from "node:crypto";

import { containerName, encodeCreateRequest } from "./docker-engine-codec.js";
import type { DockerContainerCreate, DockerEnginePolicy } from "./docker-engine-port.js";

export const createSpecificationSha256 = (
  input: DockerContainerCreate,
  policy: DockerEnginePolicy,
): string => {
  const request = encodeCreateRequest(input, policy);
  const host = request.HostConfig as Readonly<Record<string, unknown>>;
  const specification = [
    containerName(input.operationNonceSha256),
    request.Cmd,
    request.Entrypoint,
    request.Env,
    request.WorkingDir,
    request.Image,
    request.Labels,
    host.Mounts,
  ];
  return createHash("sha256").update(JSON.stringify(specification)).digest("hex");
};
