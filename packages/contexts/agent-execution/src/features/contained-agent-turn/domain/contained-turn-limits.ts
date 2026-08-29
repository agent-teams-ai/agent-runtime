export type ContainedTurnSchemaVersion = 1 | 2;

export const CONTAINED_TURN_LIMITS = Object.freeze({
  acceptedSchemaVersions: Object.freeze([1, 2] as const),
  collections: Object.freeze({
    outputChunks: 2_048,
    proofs: 64,
  }),
  text: Object.freeze({
    commandId: Object.freeze({ encoding: "ascii" as const, maximumBytes: 256 }),
    digest: Object.freeze({ encoding: "ascii" as const, maximumBytes: 71 }),
    identifier: Object.freeze({ encoding: "ascii" as const, maximumBytes: 512 }),
    outputChunk: Object.freeze({ encoding: "utf8" as const, maximumBytes: 2_000_000 }),
    outputTotal: Object.freeze({ encoding: "utf8" as const, maximumBytes: 2_000_000 }),
    prompt: Object.freeze({ encoding: "utf8" as const, maximumBytes: 65_536 }),
  }),
} as const);

export type ContainedTurnTextLimit = Readonly<{
  encoding: "ascii" | "utf8";
  maximumBytes: number;
}>;

export class ContainedTurnLimitError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "ContainedTurnLimitError";
  }
}

export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const validateContainedTurnText = (
  name: string,
  value: string,
  limit: ContainedTurnTextLimit,
): void => {
  const byteLength = utf8ByteLength(value);
  const isAscii = limit.encoding === "utf8" || /^[\x20-\x7E]+$/u.test(value);
  if (byteLength === 0 || byteLength > limit.maximumBytes || !isAscii || value.includes("\u0000")) {
    throw new ContainedTurnLimitError(
      `${name} must contain 1..${String(limit.maximumBytes)} ${limit.encoding} bytes`,
    );
  }
};

export const isContainedTurnSchemaVersion = (value: number): value is ContainedTurnSchemaVersion =>
  CONTAINED_TURN_LIMITS.acceptedSchemaVersions.some(candidate => candidate === value);
