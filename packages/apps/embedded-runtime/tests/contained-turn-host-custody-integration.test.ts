import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCodexAppServerPermissionBoundary } from "@agent-teams/agent-execution/dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-permission-boundary.js";
import {
  createHostCustodiedAgentRuntimeHost,
  createHostCustodiedContainedTurn,
  createClaudeCodeSetupInspectionPlanner,
  createCodexSetupInspectionPlanner,
} from "../dist/composition.js";
import { DeterministicCurrentOwnerHost } from "../../contexts/agent-execution/tests/current-owner-success-fixture.ts";
import { createDependencies } from "../../contexts/agent-execution/tests/features/contained-agent-turn/support/contained-agent-turn-fixture.ts";

const unavailable = (): never => {throw new Error("setup dependency must not be reached");};
const setupCapabilities = Object.freeze({
  claudeCodeSetup: Object.freeze({
    authorizeClaudeCodeSetupInspection: Object.freeze({execute: unavailable}),
    discoverClaudeCodeInstallations: Object.freeze({execute: unavailable}),
    inspectClaudeCodeConfiguration: Object.freeze({execute: unavailable}),
    planClaudeCodeSetupInspection: createClaudeCodeSetupInspectionPlanner("linux"),
  }),
  codexSetup: Object.freeze({
    authorizeSetupInspection: Object.freeze({execute: unavailable}),
    discoverCodexInstallations: Object.freeze({execute: unavailable}),
    inspectCodexConfiguration: Object.freeze({execute: unavailable}),
    planCodexSetupInspection: createCodexSetupInspectionPlanner("linux"),
  }),
});

const providerAccess = Object.freeze({
  consumeDispatchGrant: Object.freeze({async execute(input: any) {
    return Object.freeze({kind: "consumed" as const, receipt: Object.freeze({
      grantRequestRef: input.grantRequestId,
      ownerAuthorityRef: "provider-access-authority:synthetic",
      ownerReceiptRef: "provider-access-receipt:synthetic",
      validThroughOperationCutoffRevision: input.subject.operationCutoffRevision,
    })});
  }}),
  resolve: Object.freeze({async execute(input: any) {
    return Object.freeze({
      binding: Object.freeze({
        accessRef: "access:synthetic", credentialBindingDigest: "credential-owner-digest:synthetic",
        credentialBindingRef: "credential-binding:synthetic", credentialGeneration: 1,
        projectId: input.scope.projectId, provider: input.provider, providerAccountRef: "account:synthetic",
        providerRouteRef: "route:synthetic", revision: 1, tenantId: input.scope.tenantId,
      }),
      evidence: Object.freeze({authorityDigest: "authority:acceptance", bindingAuthorityDigest: "binding:synthetic",
        proofRef: "proof:acceptance", purpose: "acceptance" as const}),
      kind: "resolved" as const,
    });
  }}),
  revalidate: Object.freeze({async execute(input: any) {
    return Object.freeze({
      binding: input.binding,
      evidence: Object.freeze({authorityDigest: "authority:dispatch", bindingAuthorityDigest: "binding:synthetic",
        proofRef: "proof:dispatch", purpose: "dispatch" as const}),
      kind: "valid" as const,
    });
  }}),
  settleDispatchGrant: Object.freeze({async execute() {return Object.freeze({kind: "settled" as const});}}),
});

class AmbiguousReleaseHost extends DeterministicCurrentOwnerHost {
  public override async release() {
    this.releases += 1;
    return Object.freeze({evidenceRef: "evidence:ambiguous-release", kind: "unproven" as const});
  }
}

const createCompositionInput = async (hostCustody: DeterministicCurrentOwnerHost, root: string) => {
  const fixture = createDependencies();
  const workspaceRef = join(root, "workspace");
  const privateRootPath = join(root, "host-private");
  const codexHome = join(privateRootPath, "home");
  const tmpDir = join(privateRootPath, "temp");
  await Promise.all([
    mkdir(workspaceRef, {recursive: true, mode: 0o700}),
    mkdir(codexHome, {recursive: true, mode: 0o700}),
    mkdir(tmpDir, {recursive: true, mode: 0o700}),
  ]);
  return Object.freeze({
    fixture,
    input: Object.freeze({
      operationStore: fixture.dependencies.operationStore,
      security: fixture.dependencies.security,
      providerAccess,
      workspace: fixture.dependencies.workspace,
      artifacts: fixture.dependencies.artifacts,
      hostCustody,
      selectedProvider: Object.freeze({
        kind: "codex" as const,
        owner: Object.freeze({
          hostBootId: "host-boot:embedded-custody",
          hostInstanceId: "host-instance:embedded-custody",
          launchRecords: Object.freeze({async resolve() {
            return Object.freeze({
              boundary: createCodexAppServerPermissionBoundary({codexHome, workspaceRef}),
              executablePath: "/synthetic/codex", privateRootPath, tmpDir,
            });
          }}),
          workspaceOwner: Object.freeze({async withLaunchAuthority<Result>(
            _input: unknown,
            consume: (authority: Readonly<{canonicalPath: string; descriptorPath: string;
              identity: Readonly<{dev: bigint; ino: bigint; mountId: string}>}>) => Promise<Result>,
          ): Promise<Result> {
            return consume(Object.freeze({canonicalPath: workspaceRef, descriptorPath: "/proc/self/fd/99",
              identity: Object.freeze({dev: 1n, ino: 2n, mountId: "mount:synthetic"})}));
          }}),
        }),
      }),
    }),
  });
};

const submit = Object.freeze({
  commandId: "command:embedded-host-custody", expectedProvider: "codex",
  intent: Object.freeze({mode: "analysis" as const, prompt: "Inspect the disposable synthetic workspace."}),
  scope: Object.freeze({projectId: "project:one", tenantId: "tenant:one"}),
});

test("product Host composition routes provider execution through the same custody authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-host-custody-"));
  const custody = new DeterministicCurrentOwnerHost();
  try {
    const composed = await createCompositionInput(custody, root);
    const host = createHostCustodiedAgentRuntimeHost({
      capabilities: setupCapabilities, containedTurn: composed.input,
    });
    const access = host.bindAccess({containedTurn: submit.scope});
    const accepted = await access.containedTurn.submit(submit);
    assert.equal(accepted.status, "accepted");
    let observation = await access.containedTurn.observe(accepted.operationId);
    for (let index = 0; index < 50 && observation.status === "observed" &&
      !["cancelled", "failed", "reconcile_required", "succeeded"].includes(observation.turn.status); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 1));
      observation = await access.containedTurn.observe(accepted.operationId);
    }
    assert.equal(observation.status, "observed");
    assert.equal(observation.status === "observed" && observation.turn.status, "succeeded");
    assert.deepEqual({containments: custody.containments, finalities: custody.finalities,
      releases: custody.releases, reserves: custody.reserves, starts: custody.starts},
    {containments: 1, finalities: 1, releases: 1, reserves: 1, starts: 1});
    await host.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});

test("ambiguous Host release is nonterminal and quarantines the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "embedded-host-custody-ambiguous-"));
  const custody = new AmbiguousReleaseHost();
  try {
    const composed = await createCompositionInput(custody, root);
    const product = createHostCustodiedContainedTurn(composed.input);
    const outcome = await product.feature.submit.execute(submit);
    assert.equal(outcome.status, "observed");
    assert.equal(outcome.status === "observed" && outcome.turn.status, "reconcile_required");
    assert.equal(custody.releases, 1);
    assert.equal(composed.fixture.workspaceQuarantines.length, 1);
    product.dispose();
  } finally {await rm(root, {recursive: true, force: true});}
});
