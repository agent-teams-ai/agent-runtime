import type {OrdinarySessionObservation} from "../contracts/ordinary-session-observation.js";
import {constants, closeSync, fsyncSync, lstatSync, openSync, writeSync, realpathSync} from "node:fs";
import {join, parse, resolve} from "node:path";
import {randomUUID} from "node:crypto";
/** Owner-local synchronous, non-secret evidence. No provider content or credentials are accepted. */
export function createOrdinaryObservationJournal(root: string) {
  if (resolve(root) !== root) {throw new Error("ordinary_evidence_path_invalid");}
  let current = parse(root).root;
  for (const part of root.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part); const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {throw new Error("ordinary_evidence_path_invalid");}
  }
  const stat = lstatSync(root);
  if (realpathSync(root) !== root || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {throw new Error("ordinary_evidence_root_not_private");}
  const path = join(root, `ordinary-${randomUUID()}.jsonl`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  try {
    fsyncSync(fd);
    const dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {fsyncSync(dir);} finally {closeSync(dir);}
  } catch (error) {closeSync(fd); throw error;}
  return Object.freeze({
    record(event: OrdinarySessionObservation): void {
      if (closed) {throw new Error("ordinary_journal_closed");}
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (bytes.length > 16384) {throw new Error("ordinary_evidence_limit");}
      let offset = 0;
      while (offset < bytes.length) {const wrote = writeSync(fd, bytes, offset); if (wrote <= 0) {throw new Error("ordinary_evidence_write_incomplete");} offset += wrote;}
      fsyncSync(fd);
    },
    close(): void {if (!closed) {closed = true; closeSync(fd);}},
  });
}
