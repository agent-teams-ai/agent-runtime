import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { digestContainedTurnCanonicalValue } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-codecs.js";
import { containedTurnIdentity } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js";
import { containedTurnOperationCutoffRevision } from "../../../../dist/features/contained-agent-turn/domain/contained-turn-output-authority.js";

export const ids = (provider: "claude" | "codex", suffix: string) => Object.freeze({
  attemptId: containedTurnIdentity("attempt", `attempt:${provider}:${suffix}`),
  authorityVectorDigest: digestContainedTurnCanonicalValue({ provider, suffix }),
  custodyId: containedTurnIdentity("custody", `custody:${provider}:${suffix}`),
  commandId: containedTurnIdentity("command", `command:${provider}:${suffix}`),
  effectId: containedTurnIdentity("effect", `effect:${provider}:${suffix}`),
  operationCutoffRevision: containedTurnOperationCutoffRevision(0),
  operationId: containedTurnIdentity("operation", `operation:${provider}:${suffix}`),
  operationRevision: 1,
  preparationToken: containedTurnIdentity("preparation", `preparation:${provider}:${suffix}`),
  workspaceId: containedTurnIdentity("workspace", `workspace:opaque:${provider}:${suffix}`),
});
export const access = (provider: "claude" | "codex") => Object.freeze({
  accessRef: `access:${provider}`, credentialBindingDigest: digestContainedTurnCanonicalValue({ provider }),
  credentialBindingRef: `credential-binding:${provider}`, credentialGeneration: 1,
  ownerAuthorityDigest: `owner:${provider}`, projectId: "project:test", provider,
  providerAccountRef: `account:${provider}`, providerRouteRef: `route:${provider}`,
  revision: 1, tenantId: "tenant:test",
});
export const codexCredentialOutputInventory = (
  authority: Pick<ReturnType<typeof access>, "credentialBindingDigest" | "credentialGeneration">,
  sensitiveOutputTokens: readonly string[] = [],
) => Object.freeze({
  credentialBindingDigest: authority.credentialBindingDigest,
  credentialGeneration: authority.credentialGeneration,
  sensitiveOutputTokens: Object.freeze([...sensitiveOutputTokens]),
});

export class FakeHost {
  readonly plans: unknown[] = [];
  readonly refs = new Map<string, string>();
  readonly startInputs: unknown[] = [];
  reserves = 0;
  releases = 0;
  starts = 0;
  contained = false;
  containments = 0;
  async reserve(input: any) {
    this.reserves += 1;
    const custodyRef = `urn:agent-runtime:host-custody:random-${this.reserves}`;
    this.refs.set(input.attemptId, custodyRef);
    this.plans.push(input.launchPlan);
    return Object.freeze({ custodyRef });
  }
  async open() {throw new Error("owner integration must use reserve");}
  start(custodyRef: string, input: unknown) {
    assert.ok([...this.refs.values()].includes(custodyRef));
    this.startInputs.push(input);
    this.starts += 1;
    return Object.freeze({
      exitCode: null, killed: false, stdin: {}, stdout: {}, kill: () => true,
      off: () => {}, on: () => {}, once: () => {},
    });
  }
  get(custodyRef: string) {
    if (![...this.refs.values()].includes(custodyRef)) {return null;}
    return Object.freeze({
      closeInput: async () => {}, custodyRef, stderr: emptyBytes(), stdout: emptyBytes(),
      waitForExit: async () => ({ code: 0, signal: null }),
      workspaceAuthorityPath: "/proc/self/fd/4" as const, write: async () => {},
    });
  }
  evidence(custodyRef: string) {
    if (![...this.refs.values()].includes(custodyRef)) {return null;}
    const started = this.starts > 0;
    const provedNoStart = !started && this.contained;
    return Object.freeze({
      closure: Object.freeze({
        limitations: Object.freeze([]), profile: "strict-linux-cgroup-v2",
        status: started ? "closed" : provedNoStart ? "not-started" : "unproven",
      }),
      fingerprint: Object.freeze({
        argumentsSha256: "1".repeat(64), binaryRevision: "binary:test", containmentProfile: "strict-linux-cgroup-v2",
        environmentKeys: Object.freeze([]), executablePathSha256: "2".repeat(64), executableSha256: "3".repeat(64),
        fingerprintSha256: "4".repeat(64), intentMode: "analysis", planSha256: "5".repeat(64),
        privatePathEnvironmentKeys: Object.freeze([]), privateRootPathSha256: "6".repeat(64),
        providerBindingSha256: "7".repeat(64), spawnMode: "sdk-delegated", workspaceSha256: "8".repeat(64),
      }),
      guardianExit: started ? Object.freeze({code: 0, signal: null, status: "observed"}) : Object.freeze({status: "unobserved"}),
      identity: started ? Object.freeze({
        binarySha256: "3".repeat(64), childProcessInstanceSha256: "9".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), pgid: 101, pid: 102,
        planSha256: "5".repeat(64), proofRef: "process-proof:test", status: "proved",
      }) : Object.freeze({
        binarySha256: "0".repeat(64), childProcessInstanceSha256: "0".repeat(64),
        hostLifecycleGenerationSha256: "a".repeat(64), planSha256: "0".repeat(64), status: "not-started",
      }),
      privateRoot: Object.freeze({identitySha256: "b".repeat(64), status: started ? "deleted" : "active"}),
      providerExit: started ? Object.freeze({code: 0, signal: null, status: "observed"}) : Object.freeze({status: "not-started"}),
      sealed: started || provedNoStart, spawn: started ? "acknowledged" : "never-started",
      stderr: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : provedNoStart ? "not-started" : "incomplete"}),
      stdout: Object.freeze({bytes: 0, sha256: "0".repeat(64), status: started ? "complete" : provedNoStart ? "not-started" : "incomplete"}),
    });
  }
  async requestContainment() {
    this.contained = true;
    this.containments += 1;
    return Object.freeze({ kind: "contained" as const, receiptRef: "receipt:test" });
  }
  async release() {this.releases += 1; return Object.freeze({ kind: "released" as const });}
}
async function* emptyBytes(): AsyncIterable<Uint8Array> {}

export const privateDirectoryCustody = Object.freeze({
  async assertPrivateDirectory(path: string): Promise<void> {
    assert.equal((await stat(path)).isDirectory(), true);
  },
});

export const workspaceOwner = (expected: ReturnType<typeof ids>, workspaceRef: string) => Object.freeze({
  async withLaunchAuthority<Result>(input: any, consume: (authority: any) => Promise<Result>): Promise<Result> {
    assert.deepEqual(input, {
      attemptId: expected.attemptId, operationId: expected.operationId, workspaceId: expected.workspaceId,
    });
    return consume(Object.freeze({
      canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
      identity: Object.freeze({ dev: 1n, ino: 2n, mountId: "mount:test" }),
    }));
  },
});

export const syntheticCodexEffectCustody = () => ({
  admit(): undefined {return undefined;},
});

export const openInput = (identity: ReturnType<typeof ids>, provider: "claude" | "codex", snapshot: any) => ({
  adapterSnapshot: snapshot, ...identity, intentMode: "analysis" as const, providerAccessSnapshot: access(provider),
});
export const executeInput = (identity: ReturnType<typeof ids>, provider: "claude" | "codex", snapshot: any) => ({
  adapterSnapshot: snapshot, ...identity, emit: async () => {},
  intent: Object.freeze({ mode: "analysis" as const, prompt: "Inspect this disposable workspace." }),
  isCancellationRequested: async () => false, providerAccessSnapshot: access(provider),
  start: Object.freeze({
    createProcess<Process>(create: () => Process): Process {return create();},
    observation: Promise.resolve(Object.freeze({
      evidenceId: containedTurnIdentity("evidence", `evidence:${provider}:synthetic-start`),
      kind: "indeterminate" as const,
    })),
  }),
});
