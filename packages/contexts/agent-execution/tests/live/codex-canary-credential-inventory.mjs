import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseStrictJson } from "../../dist/features/contained-agent-turn/adapters/outbound/host-custody/docker/engine/strict-json.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = () => new Error("invalid disposable Codex credential inventory");

/** Test-only outer composition: secret values never become Provider Access facts or evidence. */
export const readCodexCanaryCredentialInventory = async (path, credentialGeneration) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 65_536
      || metadata.size === 0 || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw invalid();
    }
    const buffer = Buffer.alloc(metadata.size + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead !== metadata.size) {throw invalid();}
    bytes = buffer.subarray(0, result.bytesRead);
  } finally {await handle.close();}
  if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1) {throw invalid();}
  let parsed;
  try {parsed = parseStrictJson(bytes);}
  catch {throw invalid();}
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {throw invalid();}
  const values = new Set();
  let nodes = 0;
  const visit = (value, depth) => {
    if (++nodes > 256 || depth > 8) {throw invalid();}
    if (typeof value === "string" && value.length > 0) {
      if (Buffer.byteLength(value) > 4_096) {throw invalid();}
      values.add(value);
    } else if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) {visit(nested, depth + 1);}
    }
  };
  visit(parsed, 0);
  if (values.size === 0) {throw invalid();}
  const fileDigest = digest(bytes);
  const tokens = new Set([fileDigest, `sha256:${fileDigest}`]);
  for (const value of values) {
    tokens.add(value);
    tokens.add(digest(value));
    tokens.add(`sha256:${digest(value)}`);
  }
  const sensitiveOutputTokens = [...tokens];
  if (sensitiveOutputTokens.length > 256
    || sensitiveOutputTokens.reduce((total, value) => total + Buffer.byteLength(value), 0) > 65_536) {
    throw invalid();
  }
  return Object.freeze({credentialBindingDigest: `sha256:${fileDigest}`, credentialGeneration,
    sensitiveOutputTokens: Object.freeze(sensitiveOutputTokens)});
};
