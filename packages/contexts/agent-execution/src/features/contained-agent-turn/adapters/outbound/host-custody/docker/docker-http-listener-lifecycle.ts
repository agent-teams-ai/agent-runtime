import { randomUUID } from "node:crypto";
import { HostHttpEgressV4Journal } from "./journal/host-http-egress-v4-journal.js";
import { v4Exact, v4Hash, v4Subject } from "./journal/host-http-egress-v4-codec.js";
import type { HostHttpEgressV4Subject } from "./journal/host-http-egress-v4-types.js";

const attemptKeys = ["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"] as const;
type Identity = Readonly<Pick<HostHttpEgressV4Subject["attempt"], typeof attemptKeys[number]> & {
  effectId: string; workspaceId: string; executionGenerationId: string;
  committedClaimSha256: string; acceptedAuthoritySha256: string;
}>;
const {evidence, target, recordIntent} = HostHttpEgressV4Journal.prototype;
const reject = (): never => {throw new TypeError("V4 listener lifecycle identity unavailable");};

/** Inert composition adapter, not an observation issuer. The existing journal
 * enforces network/listener allocation and cutoff/socket/removal release order. */
export const createDockerHttpListenerLifecycle = (input: Readonly<{
  v4: HostHttpEgressV4Journal; subject: HostHttpEgressV4Subject;
}>) => {
  v4Exact(input, ["v4", "subject"]);
  const journal = input.v4; const subject = v4Subject(input.subject);
  let bound = false;
  return Object.freeze({bind(identity: Identity) {
    if (bound) {return reject();}
    bound = true;
    v4Exact(identity, ["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId",
      "hostBootId", "effectId", "workspaceId", "executionGenerationId", "committedClaimSha256", "acceptedAuthoritySha256"]);
    if (attemptKeys.some(key => identity[key] !== subject.attempt[key]) ||
      subject.effectId !== identity.effectId || subject.workspaceId !== identity.workspaceId ||
      subject.executionGenerationId !== identity.executionGenerationId ||
      subject.committedClaimSha256 !== identity.committedClaimSha256 ||
      subject.acceptedAuthoritySha256 !== identity.acceptedAuthoritySha256 ||
      evidence.call(journal).subjectSha256 !== v4Hash(subject) || evidence.call(journal).admission !== "fresh_ledger") {return reject();}
    const record = (kind: "listener_intent" | "listener_release") =>
      recordIntent.call(journal, `command:${v4Hash(randomUUID())}`, {kind, targetSha256: target.call(journal, kind)});
    return Object.freeze({recordOpen: () => record("listener_intent"), recordRelease: () => record("listener_release")});
  }});
};
