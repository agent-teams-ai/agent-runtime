import { isAbsolute, relative, resolve, sep } from "node:path";

export type ResolvedProfileDependency =
  | {
      readonly kind: "artifact";
      readonly relativePath: string;
    }
  | {
      readonly kind: "external-file-binding";
      readonly absolutePath: string;
    }
  | {
      readonly kind: "external-executable-binding";
      readonly executable: string;
      readonly resolution: "absolute" | "path-search";
    }
  | {
      readonly kind: "non-hermetic-shell";
      readonly command: string;
    };

export class ProfileDependencyError extends Error {
  public readonly code: "EMPTY_COMMAND" | "ESCAPES_PROFILE_ROOT";

  public constructor(
    code: ProfileDependencyError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ProfileDependencyError";
  }
}

const artifactRelativePath = (root: string, candidate: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const path = relative(resolvedRoot, resolvedCandidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new ProfileDependencyError(
      "ESCAPES_PROFILE_ROOT",
      `Profile reference escapes its artifact root: ${candidate}`,
    );
  }
  return path.split(sep).join("/");
};

export const resolveProfileFileReference = (
  root: string,
  reference: string,
): ResolvedProfileDependency =>
  isAbsolute(reference)
    ? { kind: "external-file-binding", absolutePath: resolve(reference) }
    : { kind: "artifact", relativePath: artifactRelativePath(root, reference) };

export const resolveProfileExecutable = (
  root: string,
  command: string | readonly string[],
): ResolvedProfileDependency => {
  if (typeof command === "string") {
    if (command.trim().length === 0) {
      throw new ProfileDependencyError("EMPTY_COMMAND", "Command is empty");
    }
    return { kind: "non-hermetic-shell", command };
  }
  const executable = command[0];
  if (executable === undefined || executable.length === 0) {
    throw new ProfileDependencyError("EMPTY_COMMAND", "Command is empty");
  }
  if (isAbsolute(executable)) {
    return {
      kind: "external-executable-binding",
      executable: resolve(executable),
      resolution: "absolute",
    };
  }
  if (executable.includes("/") || executable.includes("\\")) {
    return {
      kind: "artifact",
      relativePath: artifactRelativePath(root, executable),
    };
  }
  return {
    kind: "external-executable-binding",
    executable,
    resolution: "path-search",
  };
};
