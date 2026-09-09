import {createHash} from "node:crypto";
import type {CodexEffectCustodyAuthority, CodexEffectCustodyExecution, CodexEffectCustodyRequest}
  from "../adapters/outbound/codex-app-server/codex-app-server-effect-custody.js";
import {readDockerWorkspaceCustody, type LaunchedDockerCustody}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {retainedHostPrivateRootBinding, type HostPrivateRootOwner} from "./host-private-root-owner.js";

/** Observation membership in ADR-0010's contained_unmediated_effect. Tokens
 * never describe opened inodes. Backing-tree writer exclusion is a deployment
 * ownership premise, not a consequence of 0700, read-only bind, or open FDs. */
type DockerEffectInput = Readonly<{
  execution: CodexEffectCustodyExecution;
  launch: LaunchedDockerCustody;
  proof: object;
  root: HostPrivateRootOwner;
  reservationCustodyRef: string;
  hostLifecycleGenerationSha256: string;
  workspaceWritable: boolean;
  backingTreeOwnership: Readonly<{kind: "exclusive-host-owned-disposable-tree"; evidenceRef: string}>;
}>;

const executionFields = ["attemptId", "custodyRef", "effectId", "operationId", "workspaceRef"] as const;
const validateRootJoin = (input: DockerEffectInput, capture: ReturnType<typeof readDockerWorkspaceCustody>,
  root: ReturnType<typeof retainedHostPrivateRootBinding>): void => {
  const key = input.launch.key;
  if (root === undefined || root.custodyRef !== input.reservationCustodyRef || input.root.snapshot().evidence.status !== "active" ||
    root.operationId !== input.execution.operationId || root.attemptId !== input.execution.attemptId ||
    key.operationId !== root.operationId || key.attemptId !== root.attemptId || key.custodyId !== input.execution.custodyRef ||
    key.hostInstanceId !== root.hostInstanceId || key.hostBootId !== root.hostBootId ||
    key.hostBootGenerationSha256 !== createHash("sha256").update(root.physicalHostBootId).digest("hex") ||
    root.hostLifecycleGenerationSha256 !== input.hostLifecycleGenerationSha256 ||
    root.canonicalWorkspacePath !== input.execution.workspaceRef ||
    root.workspaceIdentity.dev !== capture.workspace.dev || root.workspaceIdentity.ino !== capture.workspace.ino ||
    root.identity.dev !== capture.privateRoot.dev || root.identity.ino !== capture.privateRoot.ino) {
    throw new TypeError("Docker contained-turn filesystem custody join unproven");
  }
};

export const createDockerCodexEffectCustodyOwner = (input: DockerEffectInput) => {
  const capture = readDockerWorkspaceCustody(input.proof, input.launch);
  const root = retainedHostPrivateRootBinding(input.root);
  if (executionFields.some(field => typeof input.execution[field] !== "string" || input.execution[field].length === 0) ||
      input.backingTreeOwnership?.kind !== "exclusive-host-owned-disposable-tree" ||
      !/^urn:[^\s]{1,1000}$/u.test(input.backingTreeOwnership.evidenceRef)) {
    throw new TypeError("Docker contained-turn ownership unavailable");
  }
  validateRootJoin(input, capture, root);
  // Mode is checked against the actual mount table again at this composition join.
  const workspaceLine = capture.mountTable.split("\n").find(line => line.split(" ")[4] === "/workspace");
  if (!workspaceLine?.split(" ")[5]?.split(",").includes(input.workspaceWritable ? "rw" : "ro")) {
    throw new TypeError("Docker workspace mode conflicts with committed attempt");
  }
  const evidence = Object.freeze({execution: Object.freeze({...input.execution}), capture,
    authority: input.launch.authority, key: input.launch.key, root,
    backingTreeOwnership: Object.freeze({...input.backingTreeOwnership}),
    scope: Object.freeze(["image", "workspace", "agent-private", "temporary-and-runtime-system-mounts"])});
  const items = new Map<string, Readonly<{type: string; token: object}>>();
  let cut = false;
  const authority: CodexEffectCustodyAuthority = Object.freeze({admit(request: CodexEffectCustodyRequest) {
    if (executionFields.some(field => request[field] !== evidence.execution[field]) ||
      typeof request.itemId !== "string" || request.itemId.length === 0 || request.itemId.length > 1024 ||
      !["commandExecution", "fileChange"].includes(request.itemType) ||
      !["started", "updated", "completed", "terminal"].includes(request.phase)) {return;}
    const prior = items.get(request.itemId);
    if (prior !== undefined) {
      return prior.type === request.itemType && request.priorAdmission === prior.token ? prior.token : undefined;
    }
    if (cut || request.priorAdmission !== undefined || items.size >= 4096) {return;}
    const token = Object.freeze({});
    items.set(request.itemId, Object.freeze({type: request.itemType, token}));
    return token;
  }});
  return Object.freeze({authority, cutoff() {cut = true;}});
};
