export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ResourceKind = "hook" | "mcp" | "plugin" | "skill";

export interface ProfileLayer {
  readonly bindingId: string;
  readonly sourceIdentity: string;
  readonly revisionRef: string;
  readonly entries: readonly ProfileEntry[];
}

export type ProfileEntry = SettingEntry | ResourceEntry;

export interface SetSettingEntry {
  readonly target: "setting";
  readonly key: string;
  readonly operation: "set";
  readonly value: JsonValue;
}

export interface ResetSettingEntry {
  readonly target: "setting";
  readonly key: string;
  readonly operation: "reset";
}

export type SettingEntry = ResetSettingEntry | SetSettingEntry;

export interface UpsertResourceEntry {
  readonly target: "resource";
  readonly kind: ResourceKind;
  readonly id: string;
  readonly operation: "upsert";
  readonly definitionHash: string;
  readonly executable: boolean;
  readonly requiredCapabilities: readonly string[];
}

export interface DisableResourceEntry {
  readonly target: "resource";
  readonly kind: ResourceKind;
  readonly id: string;
  readonly operation: "disable";
}

export interface RemoveResourceEntry {
  readonly target: "resource";
  readonly kind: ResourceKind;
  readonly id: string;
  readonly operation: "remove";
}

export type ResourceEntry =
  | DisableResourceEntry
  | RemoveResourceEntry
  | UpsertResourceEntry;

export interface ProfileSecurityContext {
  readonly capabilityGrantRevisionRef: string;
  readonly runtimePolicyRevisionRef: string;
  readonly workspaceTrustRevisionRef: string;
  readonly binaryRevisionRef: string;
  readonly grantedCapabilities: readonly string[];
  readonly policyAllowedCapabilities: readonly string[];
  readonly providerSupportedCapabilities: readonly string[];
  readonly trustedExecutableKinds: readonly ResourceKind[];
}

export interface ProfileCompositionInput {
  readonly compositionVersion: 1;
  readonly layers: readonly ProfileLayer[];
  readonly security: ProfileSecurityContext;
}

export interface ResolvedSetting {
  readonly key: string;
  readonly state: "set" | "provider-default";
  readonly winningBindingId: string;
  readonly value?: JsonValue;
}

export type ResourceActivationReason =
  | "capability-not-granted"
  | "runtime-policy-denied"
  | "provider-unsupported"
  | "workspace-untrusted";

export interface ResourceActivation {
  readonly state: "active" | "blocked" | "disabled" | "removed";
  readonly reasons: readonly ResourceActivationReason[];
}

export interface ResolvedResource {
  readonly kind: ResourceKind;
  readonly id: string;
  readonly winningBindingId: string;
  readonly winningOperation: ResourceEntry["operation"];
  readonly definitionHash?: string;
  readonly executable?: boolean;
  readonly requiredCapabilities?: readonly string[];
  readonly activation: ResourceActivation;
}

export interface ResolvedProfileManifest {
  readonly compositionVersion: 1;
  readonly orderedLayers: readonly {
    readonly bindingId: string;
    readonly sourceIdentity: string;
    readonly revisionRef: string;
  }[];
  readonly securityRevisions: {
    readonly capabilityGrantRevisionRef: string;
    readonly runtimePolicyRevisionRef: string;
    readonly workspaceTrustRevisionRef: string;
    readonly binaryRevisionRef: string;
  };
  readonly settings: readonly ResolvedSetting[];
  readonly resources: readonly ResolvedResource[];
  readonly revisionDigest: string;
}

export type ProfileCompositionErrorCode =
  | "DUPLICATE_BINDING_ID"
  | "DUPLICATE_ENTRY_IN_LAYER"
  | "INVALID_IDENTIFIER";

export class ProfileCompositionError extends Error {
  public readonly code: ProfileCompositionErrorCode;

  public constructor(
    code: ProfileCompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ProfileCompositionError";
  }
}
