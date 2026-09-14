import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { findRepoRoot } from "../helpers/repo-root.ts";

const repoRoot = findRepoRoot();
const domain = (name) => pathToFileURL(join(
  repoRoot,
  "packages/contexts/agent-execution/dist/features/contained-agent-turn/domain",
  name,
)).href;

const codecs = await import(domain("contained-turn-codecs.js"));
const authority = await import(domain("contained-turn-dispatch-authority.js"));
const identities = await import(domain("contained-turn-identities.js"));

export const digestContainedTurnCanonicalValue = codecs.digestContainedTurnCanonicalValue;
export const completeContainedTurnDispatchGrantSubject = authority.completeContainedTurnDispatchGrantSubject;
export const containedTurnGrantSettlementRequestId = authority.containedTurnGrantSettlementRequestId;
export const containedTurnIdentity = identities.containedTurnIdentity;
