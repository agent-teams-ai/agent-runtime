import assert from "node:assert/strict";
import test from "node:test";

import { createContainedTurnProviderAccessPort } from "@agent-teams/agent-execution/composition";
import { createStaticContainedTurnProviderAccessFeature } from "@agent-teams/provider-access/composition";

// Cross-context assembly belongs to the Embedded Runtime consumer, not either feature.
test("real Provider Access revalidation accepts unchanged evidence and fails closed on drift, revocation, and scope mismatch", async () => {
  const scope = Object.freeze({ projectId: "project:kernel", tenantId: "tenant:kernel" });
  const record = {
    accessRef: "access:one",
    availability: "available" as const,
    credentialBindingDigest: "owner-issued-opaque-digest",
    credentialBindingRef: "credential-binding:one",
    credentialGeneration: 7,
    projectId: scope.projectId,
    provider: "codex" as const,
    providerAccountRef: "provider-account:one",
    providerRouteRef: "provider-route:one",
    revision: 11,
    revocation: "active" as const,
    tenantId: scope.tenantId,
  };
  let currentRecord: Omit<typeof record, "revocation"> & {
    revocation: "active" | "revoked";
  } = record;
  const currentOwner = () => createStaticContainedTurnProviderAccessFeature([
    { ...currentRecord, kind: "binding" as const },
  ]);
  const feature: ReturnType<typeof createStaticContainedTurnProviderAccessFeature> = {
    resolve: { async execute(input) { return currentOwner().resolve.execute(input); } },
    revalidate: { async execute(input) { return currentOwner().revalidate.execute(input); } },
  };
  const port = createContainedTurnProviderAccessPort(feature);
  const accepted = await port.resolveForAcceptance({
    intent: { mode: "analysis", prompt: "Inspect the disposable workspace." },
    provider: "codex",
    scope,
  });
  assert.equal(accepted.kind, "resolved");
  if (accepted.kind !== "resolved") { return; }

  const unchanged = await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:unchanged",
    scope,
  });
  assert.equal(unchanged.kind, "current");
  if (unchanged.kind === "current") {
    assert.notEqual(unchanged.dispatchProofId, accepted.acceptanceProofId);
  }

  currentRecord = { ...record, providerRouteRef: "provider-route:drifted" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:drift",
    scope,
  })).kind, "current");

  currentRecord = { ...record, revocation: "revoked" };
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:revoked",
    scope,
  })).kind, "current");

  currentRecord = record;
  assert.notEqual((await port.revalidateForDispatch({
    acceptedSnapshot: accepted.snapshot,
    operationId: "operation:scope-mismatch",
    scope: { projectId: "project:other", tenantId: scope.tenantId },
  })).kind, "current");
});
