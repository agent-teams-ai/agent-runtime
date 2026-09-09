const MAX_PENDING_TOKEN_BYTES = 4_096;
const REDACTED = "<redacted>";

const sensitiveToken = (token: string): boolean => {
  const unquoted = token.replace(/^[([{<'"`]+/u, "");
  return /^(?:[A-Za-z]:\\|\/)/u.test(unquoted) ||
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(token) ||
    /(?:sk-ant-|\bBearer(?:%20|\s|[:=]))/iu.test(token) ||
    /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret)['"`]?[:=]/iu.test(token) ||
    /"(?:args|arguments|input|tool_input)"\s*:/iu.test(token) ||
    /\b[A-Za-z0-9_-]{32,}\b/u.test(token) ||
    /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/iu.test(token);
};

// Credential labels may be separated from their values by whitespace, including
// around a quoted JSON key's colon. Retain only this finite lexical context.
const credentialLabel = /(?:^|[({[,])['"`]?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|credential|password|secret)['"`]?(:|=)?$/iu;
const bearerLabel = /(?:^|[:=])[({[<'"`]*Bearer$/iu;

/** Holds one bounded lexical token plus credential context across SDK chunks. */
export class ClaudeCanonicalOutputRedactor {
  #pending = "";
  #suppressUntilDelimiter = false;
  #context: "separator" | "value" | undefined;

  #redactToken(token: string): string {
    if (token.length === 0) {return "";}
    const context = this.#context;
    const label = credentialLabel.exec(token);
    const bearer = bearerLabel.test(token);
    this.#context = bearer || label?.[1] !== undefined ? "value"
      : label !== null ? "separator" : undefined;
    if (context === "separator" && /^[:=]['"`]?$/u.test(token)) {
      this.#context = "value";
      return REDACTED;
    }
    return context === "value" || (context === "separator" && /^[:=]/u.test(token))
      || bearer || label?.[1] !== undefined || sensitiveToken(token) ? REDACTED : token;
  }

  public push(value: string): string {
    let output = "";
    for (const character of value) {
      if (/\s/u.test(character)) {
        if (!this.#suppressUntilDelimiter) {output += this.#redactToken(this.#pending);}
        output += character;
        this.#pending = "";
        this.#suppressUntilDelimiter = false;
        continue;
      }
      if (this.#suppressUntilDelimiter) {continue;}
      this.#pending += character;
      if (Buffer.byteLength(this.#pending, "utf8") > MAX_PENDING_TOKEN_BYTES) {
        output += REDACTED;
        this.#context = undefined;
        this.#pending = "";
        this.#suppressUntilDelimiter = true;
      }
    }
    return output;
  }

  public finish(): string {
    const output = this.#suppressUntilDelimiter ? "" : this.#redactToken(this.#pending);
    this.#pending = "";
    this.#suppressUntilDelimiter = false;
    this.#context = undefined;
    return output;
  }
}

// Fallback uses the same bounded tokenizer and context transitions as streaming.
export const redactClaudeCanonicalText = (value: string): string => {
  const redactor = new ClaudeCanonicalOutputRedactor();
  return redactor.push(value) + redactor.finish();
};
