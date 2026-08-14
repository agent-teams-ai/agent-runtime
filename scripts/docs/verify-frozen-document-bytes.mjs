import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECAR_PATH = "docs/document-metadata.yaml";
const EXPECTED_FROZEN_COUNT = 36;
const ENTRY = /^  (docs\/[A-Za-z0-9._/-]+\.md):$/u;
const DIGEST = /^    content_sha256: ([a-f0-9]{64})$/u;

export class FrozenDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrozenDocumentError";
  }
}

function isFrozenPath(path) {
  return /^docs\/decisions\/000[1-5]-[a-z0-9-]+\.md$/u.test(path) ||
    /^docs\/spikes\/[a-z0-9-]+-results\.md$/u.test(path) ||
    path === "docs/spikes/runtime-profile-behavior.md";
}

export function readFrozenDigestAuthority(source) {
  const entries = new Map();
  let currentPath;
  for (const line of source.split(/\r?\n/u)) {
    const pathMatch = ENTRY.exec(line);
    if (pathMatch !== null) {
      currentPath = pathMatch[1];
      continue;
    }
    const digestMatch = DIGEST.exec(line);
    if (digestMatch === null || currentPath === undefined || !isFrozenPath(currentPath)) {
      continue;
    }
    if (entries.has(currentPath)) {
      throw new FrozenDocumentError(`Duplicate frozen path: ${currentPath}`);
    }
    entries.set(currentPath, digestMatch[1]);
    currentPath = undefined;
  }
  if (entries.size !== EXPECTED_FROZEN_COUNT) {
    throw new FrozenDocumentError(
      `Frozen authority must contain ${EXPECTED_FROZEN_COUNT} paths; found ${entries.size}.`
    );
  }
  return entries;
}

export async function verifyFrozenDocumentBytes(consumerRoot) {
  const sidecar = await readFile(resolve(consumerRoot, SIDECAR_PATH), "utf8");
  const authority = readFrozenDigestAuthority(sidecar);
  for (const [path, expected] of authority) {
    const bytes = await readFile(resolve(consumerRoot, path));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new FrozenDocumentError(
        `Frozen document digest mismatch for ${path}: expected ${expected}, received ${actual}.`
      );
    }
  }
  return authority.size;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyFrozenDocumentBytes(process.cwd()).then(
    (count) => console.log(`Verified ${count} frozen documentation files.`),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
