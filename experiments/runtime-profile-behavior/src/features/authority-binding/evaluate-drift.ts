import type {
  ActiveRuntimeBinding,
  RuntimeBindingDecision,
  RuntimeBindingDrift,
} from "./model.ts";

export const evaluateRuntimeBindingDrift = (
  active: ActiveRuntimeBinding,
  drift: RuntimeBindingDrift,
): RuntimeBindingDecision => {
  switch (drift.kind) {
    case "profile-preference-changed":
      return {
        activeSessionAction: "continue-pinned",
        nextSessionCaptureRequired:
          drift.availableRevisionRef !== active.profileRevisionRef,
        replacementRef: drift.availableRevisionRef,
        reason: "preference-is-not-authority",
      };
    case "binary-revision-available":
      return {
        activeSessionAction: "continue-pinned",
        nextSessionCaptureRequired:
          drift.availableRevisionRef !== active.binaryRevisionRef,
        replacementRef: drift.availableRevisionRef,
        reason: "binary-is-pinned",
      };
    case "authority-observed": {
      if (drift.authority.state === "revoked") {
        return {
          activeSessionAction: "retire-generation-and-restart",
          nextSessionCaptureRequired: true,
          replacementRef: drift.authority.revisionRef,
          reason: "authority-revoked",
        };
      }
      if (drift.authority.state === "unavailable") {
        return {
          activeSessionAction: "pause-fail-closed",
          nextSessionCaptureRequired: true,
          replacementRef: drift.authority.revisionRef,
          reason: "authority-unavailable",
        };
      }
      if (drift.authority.revisionRef === active.authority.revisionRef) {
        return {
          activeSessionAction: "continue-pinned",
          nextSessionCaptureRequired: false,
          reason: "authority-revision-unchanged",
        };
      }
      if (drift.authority.enforcement === "hot-reload-proven") {
        return {
          activeSessionAction: "revalidate-before-next-operation",
          nextSessionCaptureRequired: true,
          replacementRef: drift.authority.revisionRef,
          reason: "authority-can-be-enforced-in-place",
        };
      }
      return {
        activeSessionAction: "retire-generation-and-restart",
        nextSessionCaptureRequired: true,
        replacementRef: drift.authority.revisionRef,
        reason: "authority-requires-successor-generation",
      };
    }
    case "credential-generation-changed":
      return drift.previousGenerationRevoked
        ? {
            activeSessionAction: "retire-generation-and-restart",
            nextSessionCaptureRequired: false,
            replacementRef: drift.generationRef,
            reason: "credential-revoked",
          }
        : {
            activeSessionAction: "revalidate-before-next-operation",
            nextSessionCaptureRequired: false,
            replacementRef: drift.generationRef,
            reason: "credential-rebind-required",
          };
    case "workspace-trust-changed":
      return drift.executableCapabilitiesTrusted
        ? {
            activeSessionAction: "revalidate-before-next-operation",
            nextSessionCaptureRequired: true,
            replacementRef: drift.revisionRef,
            reason: "workspace-trust-revalidated",
          }
        : {
            activeSessionAction: "retire-generation-and-restart",
            nextSessionCaptureRequired: true,
            replacementRef: drift.revisionRef,
            reason: "workspace-trust-revoked",
          };
  }
};
