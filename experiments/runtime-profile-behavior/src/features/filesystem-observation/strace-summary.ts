import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { TraceSummary } from "../../model.ts";
import { redactText, type RedactionContext } from "../redaction/redact.ts";

const MUTATING_ALL_PATHS = /^(?:rmdir|unlink|unlinkat|rename|renameat|renameat2)$/;
const MUTATING_LAST_PATH = /^(?:mkdir|mkdirat|symlink|symlinkat|link|linkat|chmod|chown|truncate)$/;
const WRITE_OPEN_FLAGS = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/;
const QUOTED_PATH = /"((?:\\.|[^"])*)"/g;
const OPERATION = /^([a-zA-Z0-9_]+)\(/;

const decodeQuoted = (value: string): string => {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
};

const pathsFromLine = (line: string): readonly string[] => {
  const paths: string[] = [];
  for (const match of line.matchAll(QUOTED_PATH)) {
    const value = match[1];
    if (value !== undefined && value.startsWith("/")) {
      paths.push(decodeQuoted(value));
    }
  }
  return paths;
};

const sorted = (values: Set<string>): readonly string[] =>
  [...values].sort((left, right) => left.localeCompare(right));

const addRedacted = (
  target: Set<string>,
  path: string | undefined,
  context: RedactionContext,
): void => {
  if (path !== undefined) {
    target.add(redactText(path, context));
  }
};

export const summarizeStraceText = (
  text: string,
  context: RedactionContext,
): Omit<TraceSummary, "traceFileCount"> => {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const executes = new Set<string>();

  for (const line of text.split("\n")) {
    const paths = pathsFromLine(line);
    if (paths.length === 0) {
      continue;
    }
    const operation = OPERATION.exec(line)?.[1];

    if (operation === "execve" || operation === "execveat") {
      addRedacted(executes, paths[0], context);
    } else if (operation !== undefined && MUTATING_ALL_PATHS.test(operation)) {
      paths.forEach((path) => addRedacted(writes, path, context));
    } else if (operation === "link" || operation === "linkat") {
      addRedacted(reads, paths[0], context);
      addRedacted(writes, paths.at(-1), context);
    } else if (operation === "symlink" || operation === "symlinkat") {
      addRedacted(writes, paths.at(-1), context);
    } else if (
      (operation !== undefined && MUTATING_LAST_PATH.test(operation)) ||
      WRITE_OPEN_FLAGS.test(line)
    ) {
      addRedacted(writes, paths.at(-1), context);
    } else {
      paths.forEach((path) => addRedacted(reads, path, context));
    }
  }

  return {
    readPaths: sorted(reads),
    writePaths: sorted(writes),
    executePaths: sorted(executes),
  };
};

export const summarizeStraceFiles = async (
  tracePrefix: string,
  context: RedactionContext,
): Promise<TraceSummary> => {
  const directory = dirname(tracePrefix);
  const prefix = basename(tracePrefix);
  const files = (await readdir(directory))
    .filter((name) => name === prefix || name.startsWith(`${prefix}.`))
    .sort();
  const aggregate = {
    readPaths: new Set<string>(),
    writePaths: new Set<string>(),
    executePaths: new Set<string>(),
  };

  for (const file of files) {
    const parsed = summarizeStraceText(
      await readFile(join(directory, file), "utf8"),
      context,
    );
    parsed.readPaths.forEach((path) => aggregate.readPaths.add(path));
    parsed.writePaths.forEach((path) => aggregate.writePaths.add(path));
    parsed.executePaths.forEach((path) => aggregate.executePaths.add(path));
  }

  return {
    readPaths: sorted(aggregate.readPaths),
    writePaths: sorted(aggregate.writePaths),
    executePaths: sorted(aggregate.executePaths),
    traceFileCount: files.length,
  };
};
