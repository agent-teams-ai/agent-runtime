const MAX_PENDING_TOKEN_BYTES = 4_096;
const REDACTED = "<redacted>";

const sensitiveToken = (token: string): boolean => {
  const unquoted = token.replace(/^[([{<'"`]+/u, "");
  return /^(?:[A-Za-z]:\\|\/)/u.test(unquoted) ||
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(token) ||
    /(?:sk-ant-|\bBearer(?:%20|\s|[:=]))/iu.test(token) ||
    /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret)[:=]/iu.test(token) ||
    /"(?:args|arguments|input|tool_input)"\s*:/iu.test(token) ||
    /\b[A-Za-z0-9_-]{32,}\b/u.test(token) ||
    /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/iu.test(token);
};

export const redactClaudeCanonicalText = (value: string): string => value
  .split(/(\s+)/u)
  .map(token => token.length > 0 && !/^\s+$/u.test(token) && sensitiveToken(token) ? REDACTED : token)
  .join("");

/** Holds one lexical token so sensitive values split across SDK chunks are never partly admitted. */
export class ClaudeCanonicalOutputRedactor {
  #pending = "";
  #suppressUntilDelimiter = false;

  public push(value: string): string {
    let output = "";
    for (const character of value) {
      if (/\s/u.test(character)) {
        if (!this.#suppressUntilDelimiter) {output += redactClaudeCanonicalText(this.#pending);}
        output += character;
        this.#pending = "";
        this.#suppressUntilDelimiter = false;
        continue;
      }
      if (this.#suppressUntilDelimiter) {continue;}
      this.#pending += character;
      if (Buffer.byteLength(this.#pending, "utf8") > MAX_PENDING_TOKEN_BYTES) {
        output += REDACTED;
        this.#pending = "";
        this.#suppressUntilDelimiter = true;
      }
    }
    return output;
  }

  public finish(): string {
    const output = this.#suppressUntilDelimiter ? "" : redactClaudeCanonicalText(this.#pending);
    this.#pending = "";
    this.#suppressUntilDelimiter = false;
    return output;
  }
}
