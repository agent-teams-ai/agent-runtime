const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
const WHITESPACE = new Set(["\t", "\n", "\r", " "]);

export class StrictJsonParseError extends Error {
  public constructor() {super("malformed strict JSON"); this.name = "StrictJsonParseError";}
}

const malformed = (): never => {throw new StrictJsonParseError();};

const validateUnicode = (value: string): void => {
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const unit = value.charCodeAt(cursor);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(cursor + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {malformed();}
      cursor += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {malformed();}
  }
};

class StrictJsonParser {
  #index = 0;
  readonly #source: string;

  public constructor(source: string) {this.#source = source;}

  public parse(): unknown {
    const result = this.#value(0);
    this.#skip();
    if (this.#index !== this.#source.length) {malformed();}
    return result;
  }

  #array(depth: number): readonly unknown[] {
    this.#index += 1;
    const values: unknown[] = [];
    this.#skip();
    if (this.#source[this.#index] === "]") {this.#index += 1; return values;}
    while (values.length < 4096) {
      values.push(this.#value(depth + 1));
      this.#skip();
      if (this.#source[this.#index] === "]") {this.#index += 1; return values;}
      if (this.#source[this.#index] !== ",") {malformed();}
      this.#index += 1;
    }
    return malformed();
  }

  #keyword(keyword: "false" | "null" | "true", value: boolean | null): boolean | null {
    if (!this.#source.startsWith(keyword, this.#index)) {malformed();}
    this.#index += keyword.length;
    return value;
  }

  #number(): number {
    NUMBER.lastIndex = this.#index;
    const match = NUMBER.exec(this.#source);
    if (match?.index !== this.#index) {return malformed();}
    this.#index = NUMBER.lastIndex;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Object.is(value, -0)) {malformed();}
    return value;
  }

  #object(depth: number): Readonly<Record<string, unknown>> {
    this.#index += 1;
    const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.#skip();
    if (this.#source[this.#index] === "}") {this.#index += 1; return value;}
    while (keys.size < 4096) {
      this.#skip();
      const key = this.#string();
      if (keys.has(key)) {malformed();}
      keys.add(key);
      this.#skip();
      if (this.#source[this.#index] !== ":") {malformed();}
      this.#index += 1;
      value[key] = this.#value(depth + 1);
      this.#skip();
      if (this.#source[this.#index] === "}") {this.#index += 1; return value;}
      if (this.#source[this.#index] !== ",") {malformed();}
      this.#index += 1;
    }
    return malformed();
  }

  #skip(): void {
    while (WHITESPACE.has(this.#source[this.#index] ?? "")) {this.#index += 1;}
  }

  #string(): string {
    if (this.#source[this.#index] !== "\"") {malformed();}
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#source.length) {
      const code = this.#source.charCodeAt(this.#index);
      if (code === 0x22) {return this.#finishString(start);}
      if (code < 0x20) {malformed();}
      if (code === 0x5c) {this.#skipEscape();}
      this.#index += 1;
    }
    return malformed();
  }

  #finishString(start: number): string {
    this.#index += 1;
    try {
      const value = JSON.parse(this.#source.slice(start, this.#index)) as unknown;
      if (typeof value !== "string") {return malformed();}
      validateUnicode(value);
      return value;
    } catch {return malformed();}
  }

  #skipEscape(): void {
    this.#index += 1;
    const escape = this.#source[this.#index];
    if (escape === "u") {
      if (!/^[0-9a-fA-F]{4}$/u.test(this.#source.slice(this.#index + 1, this.#index + 5))) {malformed();}
      this.#index += 4;
    } else if (escape === undefined || !"\"\\/bfnrt".includes(escape)) {malformed();}
  }

  #value(depth: number): unknown {
    if (depth > 32) {malformed();}
    this.#skip();
    const token = this.#source[this.#index];
    if (token === "\"") {return this.#string();}
    if (token === "[") {return this.#array(depth);}
    if (token === "{") {return this.#object(depth);}
    if (token === "t") {return this.#keyword("true", true);}
    if (token === "f") {return this.#keyword("false", false);}
    if (token === "n") {return this.#keyword("null", null);}
    return this.#number();
  }
}

export const parseStrictJson = (bytes: Uint8Array): unknown => {
  try {return new StrictJsonParser(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).parse();}
  catch (error) {
    if (error instanceof StrictJsonParseError) {throw error;}
    return malformed();
  }
};
