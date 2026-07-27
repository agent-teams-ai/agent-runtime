export type AuthorityState = "current" | "revoked" | "unavailable";

export type ProviderEnforcementCapability =
  | "hot-reload-proven"
  | "restart-required"
  | "unknown";

export interface RuntimeAuthorityBinding {
  readonly revisionRef: string;
  readonly state: AuthorityState;
  readonly enforcement: ProviderEnforcementCapability;
}

export interface ActiveRuntimeBinding {
  readonly profileRevisionRef: string;
  readonly authority: RuntimeAuthorityBinding;
  readonly credentialGenerationRef: string;
  readonly workspaceTrustRevisionRef: string;
  readonly binaryRevisionRef: string;
}

export type RuntimeBindingDrift =
  | {
      readonly kind: "profile-preference-changed";
      readonly availableRevisionRef: string;
    }
  | {
      readonly kind: "authority-observed";
      readonly authority: RuntimeAuthorityBinding;
    }
  | {
      readonly kind: "credential-generation-changed";
      readonly generationRef: string;
      readonly previousGenerationRevoked: boolean;
    }
  | {
      readonly kind: "workspace-trust-changed";
      readonly revisionRef: string;
      readonly executableCapabilitiesTrusted: boolean;
    }
  | {
      readonly kind: "binary-revision-available";
      readonly availableRevisionRef: string;
    };

export type ActiveSessionAction =
  | "continue-pinned"
  | "revalidate-before-next-operation"
  | "pause-fail-closed"
  | "retire-generation-and-restart";

export interface RuntimeBindingDecision {
  readonly activeSessionAction: ActiveSessionAction;
  readonly nextSessionCaptureRequired: boolean;
  readonly replacementRef?: string;
  readonly reason:
    | "preference-is-not-authority"
    | "authority-revision-unchanged"
    | "authority-can-be-enforced-in-place"
    | "authority-requires-successor-generation"
    | "authority-revoked"
    | "authority-unavailable"
    | "credential-rebind-required"
    | "credential-revoked"
    | "workspace-trust-revalidated"
    | "workspace-trust-revoked"
    | "binary-is-pinned";
}
