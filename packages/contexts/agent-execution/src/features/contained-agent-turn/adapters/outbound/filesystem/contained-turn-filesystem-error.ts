const filesystemCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export class ContainedTurnFilesystemUnsupportedError extends Error {
  public readonly code = "ERR_CONTAINED_TURN_FILESYSTEM_UNSUPPORTED";

  public constructor(message: string) {
    super(message);
    this.name = "ContainedTurnFilesystemUnsupportedError";
  }
}

export class ContainedTurnFilesystemCustodyError extends Error {
  public readonly code = "ERR_CONTAINED_TURN_FILESYSTEM_CUSTODY";
  public readonly operation: string;

  public constructor(operation: string, message: string) {
    super(message);
    this.name = "ContainedTurnFilesystemCustodyError";
    this.operation = operation;
  }
}

export const guardContainedTurnFilesystemOperation = async <Result>(
  operation: string,
  execute: () => Promise<Result>,
  preserveTestError = false,
): Promise<Result> => {
  try {
    return await execute();
  } catch (error) {
    if (
      preserveTestError || error instanceof ContainedTurnFilesystemCustodyError ||
      error instanceof ContainedTurnFilesystemUnsupportedError
    ) {
      throw error;
    }
    const candidate = error instanceof Error ? error.message : "";
    const safeMessage = candidate.startsWith("contained turn ") &&
      !candidate.includes("/") && !candidate.includes("\\") &&
      Buffer.byteLength(candidate, "utf8") <= 512
      ? candidate
      : `contained turn filesystem ${operation} failed (${filesystemCode(error) ?? "unknown"})`;
    // eslint-disable-next-line preserve-caught-error -- public custody errors intentionally redact causes
    throw new ContainedTurnFilesystemCustodyError(operation, safeMessage);
  }
};
