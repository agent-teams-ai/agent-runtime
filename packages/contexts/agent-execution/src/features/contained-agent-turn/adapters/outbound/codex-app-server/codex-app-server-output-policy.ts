import { CodexAppServerProtocolError } from "./codex-app-server-jsonl.js";

export type CodexPrivatePathPlatform = "darwin" | "linux" | "win32";

export interface CodexCanonicalOutputPolicy {
  readonly exactSensitiveTokens: readonly string[];
  readonly privatePaths: readonly string[];
  readonly privatePathPlatform: CodexPrivatePathPlatform;
}

const CREDENTIAL_BODY = String.raw`[A-Za-z0-9._~+/=-]`;

/** Names are test-visible so the matrix must cover every independently declared policy family. */
export const CODEX_CREDENTIAL_POLICY_FAMILIES = Object.freeze([
  "synthetic-marker",
  "private-key-marker",
  "openai-sk-credential",
  "api-key-assignment",
  "authorization-bearer",
  "token-field",
] as const);

const CREDENTIAL_PATTERNS: Readonly<Record<(typeof CODEX_CREDENTIAL_POLICY_FAMILIES)[number], RegExp>> = Object.freeze({
  "synthetic-marker": /(?:credential|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token)[\s_-]*marker\s*</iu,
  "private-key-marker": /-----\s*begin\s+(?:(?:rsa|ec|openssh)\s+)?private\s+key\s*-----/iu,
  "openai-sk-credential": new RegExp(String.raw`sk-${CREDENTIAL_BODY}{20}`, "iu"),
  "api-key-assignment": new RegExp(
    String.raw`(?:openai|codex)[\s_-]*api[\s_-]*key\s*(?:=|:)\s*["']?${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
  "authorization-bearer": new RegExp(
    String.raw`authorization\s*:\s*bearer\s+${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
  "token-field": new RegExp(
    String.raw`["']?(?:access|refresh|id)[\s_-]*token["']?\s*(?:=|:)\s*["']?${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
});

const canonicalCaseFold = (value: string): string =>
  value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

const pathComparable = (value: string, platform: CodexPrivatePathPlatform): string =>
  platform === "linux" ? value : canonicalCaseFold(value);

export const codexTextContainsPrivatePath = (
  text: string,
  privatePaths: readonly string[],
  platform: CodexPrivatePathPlatform,
): boolean => {
  const comparableText = pathComparable(text, platform);
  return privatePaths.some(path => comparableText.includes(pathComparable(path, platform)));
};

export const codexTerminalOutputText = (
  text: string,
  exactSensitiveTokens: readonly string[],
): string => {
  let retainedLength = 0;
  for (const token of exactSensitiveTokens) {
    const maximum = Math.min(text.length, token.length - 1);
    for (let length = maximum; length > retainedLength; length -= 1) {
      if (text.endsWith(token.slice(0, length))) {retainedLength = length; break;}
    }
  }
  return retainedLength === 0 ? text : text.slice(0, -retainedLength);
};

/** Bounded declared shapes plus exact owner-authorized tokens; this is not arbitrary secret discovery. */
export const assertCodexCanonicalOutputAllowed = (
  text: string,
  policy: CodexCanonicalOutputPolicy,
): void => {
  if (policy.exactSensitiveTokens.some(token => text.includes(token))
    || codexTextContainsPrivatePath(text, policy.privatePaths, policy.privatePathPlatform)
    || CODEX_CREDENTIAL_POLICY_FAMILIES.some(family => CREDENTIAL_PATTERNS[family].test(text))) {
    throw new CodexAppServerProtocolError("Codex output matched the bounded private-output policy", true);
  }
};
