import { CodexAppServerProtocolError } from "./codex-app-server-jsonl.js";

export type CodexPrivatePathPlatform = "darwin" | "linux" | "win32";

export interface CodexCanonicalOutputPolicy {
  readonly exactSensitiveTokens: readonly string[];
  readonly privatePaths: readonly string[];
  readonly privatePathPlatform: CodexPrivatePathPlatform;
}

const CREDENTIAL_BODY = String.raw`[A-Za-z0-9._~+/=-]`;
const TERMINAL_CREDENTIAL_PREFIX_WINDOW = 512;
const GAP = String.raw`[\t\n\r ]{0,32}`;
const REQUIRED_GAP = String.raw`[\t\n\r ]{1,32}`;
const NAME_GAP = String.raw`[\t\n\r _-]{0,32}`;

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
  "synthetic-marker": new RegExp(
    String.raw`(?:credential|api${NAME_GAP}key|access${NAME_GAP}token|refresh${NAME_GAP}token)${NAME_GAP}marker${GAP}<`,
    "iu",
  ),
  "private-key-marker": new RegExp(
    String.raw`-----${GAP}begin${REQUIRED_GAP}(?:(?:encrypted|rsa|ec|openssh)${REQUIRED_GAP})?private${REQUIRED_GAP}key${GAP}-----`,
    "iu",
  ),
  "openai-sk-credential": new RegExp(String.raw`sk-${CREDENTIAL_BODY}{20}`, "iu"),
  "api-key-assignment": new RegExp(
    String.raw`["']?(?:(?:openai|codex)${NAME_GAP})?api${NAME_GAP}key["']?${GAP}(?:=|:)${GAP}["']?${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
  "authorization-bearer": new RegExp(
    String.raw`["']?authorization["']?${GAP}(?:=|:)${GAP}["']?bearer${REQUIRED_GAP}${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
  "token-field": new RegExp(
    String.raw`["']?(?:access|refresh|id)${NAME_GAP}token["']?${GAP}(?:=|:)${GAP}["']?${CREDENTIAL_BODY}{16}`,
    "iu",
  ),
});

const canonicalCaseFold = (value: string): string =>
  value.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");

const collapseLexicalPathAliases = (value: string): string => {
  const segments = value.replace(/\/{2,}/gu, "/").split("/");
  const canonical: string[] = [];
  for (const segment of segments) {
    if (segment === ".") {continue;}
    if (segment === ".." && canonical.length > 0 && canonical.at(-1) !== "" && canonical.at(-1) !== "..") {
      canonical.pop();
      continue;
    }
    canonical.push(segment);
  }
  return canonical.join("/");
};

const windowsLexicalComparable = (value: string): string => canonicalCaseFold(value).replaceAll("\\", "/");

const windowsPathComparable = (value: string): string => windowsLexicalComparable(value)
  .replace(/(^|[^/])\/{2,}[?.]\/+(?:unc\/+)?/gu, "$1/")
  .replace(/(^|[^/])\/+\?\?\/+(?:unc\/+)?/gu, "$1/");

const pathComparable = (value: string, platform: CodexPrivatePathPlatform): string => {
  const lexical = platform === "linux" ? value
    : platform === "win32" ? windowsPathComparable(value) : canonicalCaseFold(value);
  return collapseLexicalPathAliases(lexical);
};

export const codexTextContainsPrivatePath = (
  text: string,
  privatePaths: readonly string[],
  platform: CodexPrivatePathPlatform,
): boolean => {
  const comparableText = pathComparable(text, platform);
  return privatePaths.some(path => comparableText.includes(pathComparable(path, platform)));
};

const longestPrefixAtTextEnd = (text: string, target: string): number => {
  if (text.length === 0 || target.length === 0) {return 0;}
  const tail = text.slice(Math.max(0, text.length - target.length + 1));
  const prefix = new Uint32Array(target.length);
  for (let index = 1; index < target.length; index += 1) {
    let length = prefix[index - 1] ?? 0;
    while (length > 0 && target[index] !== target[length]) {length = prefix[length - 1] ?? 0;}
    if (target[index] === target[length]) {length += 1;}
    prefix[index] = length;
  }
  let matched = 0;
  for (let index = 0; index < tail.length; index += 1) {
    const character = tail[index];
    while (matched > 0 && character !== target[matched]) {matched = prefix[matched - 1] ?? 0;}
    if (character === target[matched]) {matched += 1;}
  }
  return matched;
};

const textEndsWithProperPrefix = (text: string, target: string): boolean => {
  const length = longestPrefixAtTextEnd(text, target);
  return length > 0 && length < target.length;
};

const terminalPrivatePathTargets = (
  path: string,
  platform: CodexPrivatePathPlatform,
): readonly string[] => {
  if (platform !== "win32") {return [pathComparable(path, platform)];}
  return [pathComparable(path, platform)];
};

const CREDENTIAL_SKELETONS = Object.freeze([
  ["credentialmarker<", 0], ["apikeymarker<", 0], ["accesstokenmarker<", 0], ["refreshtokenmarker<", 0],
  ["beginprivatekey#", 0], ["beginencryptedprivatekey#", 0], ["beginrsaprivatekey#", 0],
  ["beginecprivatekey#", 0], ["beginopensshprivatekey#", 0], ["sk", 20],
  ["openaiapikey=", 16], ["openaiapikey:", 16], ["codexapikey=", 16], ["codexapikey:", 16],
  ["apikey=", 16], ["apikey:", 16], ["{apikey=", 16], ["{apikey:", 16],
  ["authorization:bearer", 16], ["authorization=bearer", 16],
  ["accesstoken=", 16], ["accesstoken:", 16], ["refreshtoken=", 16], ["refreshtoken:", 16],
  ["idtoken=", 16], ["idtoken:", 16],
] as const);

const credentialSkeleton = (value: string): string => canonicalCaseFold(value)
  .replace(/[\s'"_-]/gu, "");

const rangeMatches = (value: string, offset: number, expected: string, length: number): boolean => {
  for (let index = 0; index < length; index += 1) {
    if (value[offset + index] !== expected[index]) {return false;}
  }
  return true;
};

const credentialSkeletonCouldExtend = (value: string, offset: number): boolean => {
  const candidateLength = value.length - offset;
  if (candidateLength === 0) {return false;}
  for (const [leader, minimumBodyLength] of CREDENTIAL_SKELETONS) {
    if (candidateLength < leader.length && rangeMatches(value, offset, leader, candidateLength)) {return true;}
    if (minimumBodyLength > 0 && candidateLength >= leader.length
      && rangeMatches(value, offset, leader, leader.length)) {
      const bodyLength = candidateLength - leader.length;
      if (bodyLength >= minimumBodyLength) {continue;}
      let boundedBody = true;
      for (let index = offset + leader.length; index < value.length; index += 1) {
        if (!/[a-z0-9.~+/=]/u.test(value[index] ?? "")) {boundedBody = false; break;}
      }
      if (boundedBody) {return true;}
    }
  }
  return false;
};

const textEndsWithCredentialLanguagePrefix = (text: string): boolean => {
  const tail = text.slice(-TERMINAL_CREDENTIAL_PREFIX_WINDOW);
  if (/(?:^|[^-])-{1,5}[\t\n\r ]{0,32}$/u.test(tail) || /["']$/u.test(tail)) {return true;}
  const skeleton = credentialSkeleton(tail);
  for (let start = 0; start < skeleton.length; start += 1) {
    if (credentialSkeletonCouldExtend(skeleton, start)) {return true;}
  }
  return false;
};

export const codexTerminalOutputText = (
  text: string,
  policy: CodexCanonicalOutputPolicy,
): string => {
  const pathText = pathComparable(text, policy.privatePathPlatform);
  const unsafeExactPrefix = policy.exactSensitiveTokens.some(token => textEndsWithProperPrefix(text, token));
  const unsafePathPrefix = policy.privatePaths.some(path => terminalPrivatePathTargets(path, policy.privatePathPlatform)
    .some(target => textEndsWithProperPrefix(pathText, target)));
  return unsafeExactPrefix || unsafePathPrefix || textEndsWithCredentialLanguagePrefix(text) ? "" : text;
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
