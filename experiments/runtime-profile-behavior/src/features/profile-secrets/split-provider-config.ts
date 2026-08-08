export type ConfigPathPattern = readonly string[];

export interface CredentialFieldRule {
  readonly path: ConfigPathPattern;
  readonly kind: "api-key" | "credential" | "token";
}

export interface CredentialRequirement {
  readonly path: string;
  readonly kind: CredentialFieldRule["kind"];
  readonly bindingRef: string;
}

export interface SplitProviderConfigResult {
  readonly profileConfig: Readonly<Record<string, unknown>>;
  readonly credentialRequirements: readonly CredentialRequirement[];
}

export type CredentialBinder = (input: {
  readonly path: string;
  readonly kind: CredentialFieldRule["kind"];
  readonly secret: string;
}) => string;

export class ProviderConfigClassificationError extends Error {
  public readonly code: "INLINE_SECRET" | "UNCLASSIFIED_SECRET";

  public constructor(
    code: ProviderConfigClassificationError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ProviderConfigClassificationError";
  }
}

const secretFieldName =
  /(?:api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|token)/i;
const inlineSecret =
  /(?:\bBearer\s+\S+|https?:\/\/[^\s/:]+:[^\s/@]+@|-----BEGIN [^-]*PRIVATE KEY-----)/i;

const matches = (
  path: readonly string[],
  pattern: ConfigPathPattern,
): boolean =>
  path.length === pattern.length &&
  path.every((segment, index) => {
    const expected = pattern[index];
    return expected === "*" || expected === segment;
  });

const pointer = (path: readonly string[]): string =>
  `/${path
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const splitProviderConfig = (
  input: Readonly<Record<string, unknown>>,
  rules: readonly CredentialFieldRule[],
  bindCredential: CredentialBinder,
): SplitProviderConfigResult => {
  const requirements: CredentialRequirement[] = [];

  const visit = (value: unknown, path: readonly string[]): unknown => {
    const rule = rules.find((candidate) => matches(path, candidate.path));
    if (rule !== undefined) {
      if (typeof value !== "string" || value.length === 0) {
        throw new ProviderConfigClassificationError(
          "UNCLASSIFIED_SECRET",
          `Credential field must contain a non-empty string: ${pointer(path)}`,
        );
      }
      const bindingRef = bindCredential({
        path: pointer(path),
        kind: rule.kind,
        secret: value,
      });
      requirements.push({ path: pointer(path), kind: rule.kind, bindingRef });
      return { $credentialBinding: bindingRef };
    }

    const leaf = path.at(-1);
    if (leaf !== undefined && secretFieldName.test(leaf)) {
      throw new ProviderConfigClassificationError(
        "UNCLASSIFIED_SECRET",
        `Secret-shaped field has no provider classification: ${pointer(path)}`,
      );
    }
    if (typeof value === "string" && inlineSecret.test(value)) {
      throw new ProviderConfigClassificationError(
        "INLINE_SECRET",
        `Inline credential is forbidden in profile config: ${pointer(path)}`,
      );
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, [...path, String(index)]));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          visit(item, [...path, key]),
        ]),
      );
    }
    return value;
  };

  return {
    profileConfig: visit(input, []) as Readonly<Record<string, unknown>>,
    credentialRequirements: requirements.toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
};
