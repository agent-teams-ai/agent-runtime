export type DockerEngineFailureCode =
  | "aborted"
  | "authority-conflict"
  | "create-acknowledgement-unknown"
  | "mutation-acknowledgement-unknown"
  | "start-acknowledgement-unknown"
  | "daemon-disconnected"
  | "daemon-identity-changed"
  | "deadline-exceeded"
  | "invalid-authority"
  | "invalid-create-request"
  | "malformed-response"
  | "protocol-violation"
  | "request-rejected"
  | "resource-already-exists"
  | "resource-not-found"
  | "response-too-large"
  | "stream-frame-too-large"
  | "stream-too-large"
  | "stream-truncated"
  | "terminal-observation-unknown"
  | "unsupported-platform"
  | "endpoint-custody-lost";

const messages: Readonly<Record<DockerEngineFailureCode, string>> = Object.freeze({
  aborted: "Docker Engine operation aborted",
  "authority-conflict": "Docker container authority does not match the observed resource",
  "create-acknowledgement-unknown": "Docker container create acknowledgement is unknown",
  "mutation-acknowledgement-unknown": "Docker container mutation acknowledgement is unknown",
  "start-acknowledgement-unknown": "Docker container start acknowledgement is unknown",
  "daemon-disconnected": "Docker Engine connection closed",
  "daemon-identity-changed": "Docker daemon identity changed",
  "deadline-exceeded": "Docker Engine operation deadline exceeded",
  "invalid-authority": "Docker container authority is invalid",
  "invalid-create-request": "Docker container create request is invalid",
  "malformed-response": "Docker Engine returned a malformed response",
  "protocol-violation": "Docker Engine protocol response was refused",
  "request-rejected": "Docker Engine refused the bounded operation",
  "resource-already-exists": "Docker container name is already in use",
  "resource-not-found": "Docker container resource was not found",
  "response-too-large": "Docker Engine response exceeded its bound",
  "stream-frame-too-large": "Docker Engine stream frame exceeded its bound",
  "stream-too-large": "Docker Engine stream exceeded its bound",
  "stream-truncated": "Docker Engine stream ended inside a frame",
  "terminal-observation-unknown": "Docker container terminal observation is unknown",
  "unsupported-platform": "Docker Engine Unix peer custody is unsupported on this platform",
  "endpoint-custody-lost": "Docker Engine Unix socket custody was lost",
});

export class DockerEngineError extends Error {
  public readonly code: DockerEngineFailureCode;
  public readonly statusCode?: number;

  public constructor(code: DockerEngineFailureCode, statusCode?: number) {
    super(messages[code]);
    this.name = "DockerEngineError";
    this.code = code;
    if (statusCode !== undefined) {this.statusCode = statusCode;}
  }
}
