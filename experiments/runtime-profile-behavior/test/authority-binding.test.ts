import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRuntimeBindingDrift } from "../src/features/authority-binding/evaluate-drift.ts";
import type { ActiveRuntimeBinding } from "../src/features/authority-binding/model.ts";

const active: ActiveRuntimeBinding = {
  profileRevisionRef: "profile:v1",
  authority: {
    revisionRef: "policy:v1",
    state: "current",
    enforcement: "restart-required",
  },
  credentialGenerationRef: "credential:g1",
  workspaceTrustRevisionRef: "trust:v1",
  binaryRevisionRef: "binary:v1",
};

test("ordinary preference drift never interrupts an active session", () => {
  assert.deepEqual(
    evaluateRuntimeBindingDrift(active, {
      kind: "profile-preference-changed",
      availableRevisionRef: "profile:v2",
    }),
    {
      activeSessionAction: "continue-pinned",
      nextSessionCaptureRequired: true,
      replacementRef: "profile:v2",
      reason: "preference-is-not-authority",
    },
  );
});

test("unavailable authority fails closed without pretending it was revoked", () => {
  const decision = evaluateRuntimeBindingDrift(active, {
    kind: "authority-observed",
    authority: {
      revisionRef: "policy:unknown",
      state: "unavailable",
      enforcement: "unknown",
    },
  });

  assert.equal(decision.activeSessionAction, "pause-fail-closed");
  assert.equal(decision.reason, "authority-unavailable");
});

test("unproven policy hot reload creates a successor execution generation", () => {
  const decision = evaluateRuntimeBindingDrift(active, {
    kind: "authority-observed",
    authority: {
      revisionRef: "policy:v2",
      state: "current",
      enforcement: "unknown",
    },
  });

  assert.equal(decision.activeSessionAction, "retire-generation-and-restart");
  assert.equal(decision.reason, "authority-requires-successor-generation");
});

test("revoked credentials and workspace trust retire execution authority", () => {
  const credential = evaluateRuntimeBindingDrift(active, {
    kind: "credential-generation-changed",
    generationRef: "credential:g2",
    previousGenerationRevoked: true,
  });
  const trust = evaluateRuntimeBindingDrift(active, {
    kind: "workspace-trust-changed",
    revisionRef: "trust:v2",
    executableCapabilitiesTrusted: false,
  });

  assert.equal(credential.activeSessionAction, "retire-generation-and-restart");
  assert.equal(trust.activeSessionAction, "retire-generation-and-restart");
});
