const SENSITIVE_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[=:]\s*)([^\s,;"']+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export interface RedactionContext {
  readonly roots?: Readonly<Record<string, string>>;
  readonly literalSecrets?: readonly string[];
}

const replaceAllLiteral = (
  input: string,
  value: string,
  replacement: string,
): string => {
  if (value.length === 0) {
    return input;
  }
  return input.split(value).join(replacement);
};

export const redactText = (
  value: string,
  context: RedactionContext = {},
): string => {
  let redacted = value;

  for (const [label, root] of Object.entries(context.roots ?? {})) {
    redacted = replaceAllLiteral(redacted, root, `<${label}>`);
  }

  for (const secret of context.literalSecrets ?? []) {
    redacted = replaceAllLiteral(redacted, secret, "<REDACTED>");
  }

  return redacted
    .replace(PRIVATE_KEY, "<REDACTED_PRIVATE_KEY>")
    .replace(BEARER_TOKEN, "Bearer <REDACTED>")
    .replace(JWT, "<REDACTED_JWT>")
    .replace(EMAIL, "<REDACTED_EMAIL>")
    .replace(SENSITIVE_ASSIGNMENT, "$1<REDACTED>");
};

export const sensitiveEnvironmentPresence = (
  environment: NodeJS.ProcessEnv,
  keys: readonly string[],
): Readonly<Record<string, boolean>> =>
  Object.fromEntries(keys.map((key) => [key, Boolean(environment[key])]));

export const assertNoKnownSecret = (
  value: string,
  secrets: readonly string[],
): void => {
  for (const secret of secrets) {
    if (secret.length > 0 && value.includes(secret)) {
      throw new Error("Redaction failed: a known secret remains in evidence");
    }
  }
};
