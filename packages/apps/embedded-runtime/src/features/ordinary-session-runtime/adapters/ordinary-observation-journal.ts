import type {OrdinarySessionObservation} from "../contracts/ordinary-session-observation.js";
import {constants, closeSync, fsyncSync, lstatSync, openSync, writeSync, realpathSync} from "node:fs";
import {join, parse, resolve} from "node:path";
import {randomUUID} from "node:crypto";

function descriptorOwner(fd: number) {
  let state: {kind: "open"} | {kind: "closed"} | {kind: "failed"; cause: unknown} = {kind: "open"};
  return {
    assertOpen(): void {
      if (state.kind === "failed") {throw state.cause;}
      if (state.kind === "closed") {throw new Error("ordinary_journal_closed");}
    },
    close(): void {
      if (state.kind === "failed") {throw state.cause;}
      if (state.kind === "closed") {return;}
      try {closeSync(fd); state = {kind: "closed"};}
      catch (cause) {
        // A thrown close does not prove whether the OS released this number.
        // Retain uncertainty; never close a potentially reused descriptor.
        state = {kind: "failed", cause}; throw cause;
      }
    },
  };
}

/** Owner-local handoff of initialization uncertainty to Host composition. */
export class OrdinaryJournalInitializationError extends AggregateError {
  readonly #recovery: {recover(): Promise<void>};
  constructor(primary: unknown, cleanupCauses: readonly unknown[], release: () => void) {
    super([primary, ...cleanupCauses], "ordinary_journal_initialization_cleanup_incomplete", {cause: primary});
    let flight: Promise<void> | undefined;
    this.#recovery = Object.freeze({
      recover: (): Promise<void> => flight ??= Promise.resolve().then(release).catch((cause: unknown) => {flight = undefined; throw cause;}),
    });
  }
  get cleanupRecovery(): {recover(): Promise<void>} {return this.#recovery;}
  static is(value: unknown): value is OrdinaryJournalInitializationError {
    return value !== null && typeof value === "object" && #recovery in value;
  }
}
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
  const file = descriptorOwner(fd);
  let directory: ReturnType<typeof descriptorOwner> | undefined;
  try {
    fsyncSync(fd);
    const dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directory = descriptorOwner(dir);
    fsyncSync(dir);
    directory.close();
  } catch (error) {
    const errors: unknown[] = [];
    const release = () => {
      const failures: unknown[] = [];
      for (const owner of [directory, file]) {try {owner?.close();} catch (cause) {failures.push(cause);}}
      if (failures.length > 0) {throw new AggregateError(failures, "ordinary_journal_cleanup_uncertain", {cause: error});}
    };
    try {release();} catch (cause) {errors.push(cause);}
    if (errors.length === 0) {throw error;}
    // Failed initialization publishes only retained cleanup custody. Causes
    // and the descriptor owners remain absent from JSON/enumerable fields.
    throw new OrdinaryJournalInitializationError(error, errors, release);
  }
  return Object.freeze({
    record(event: OrdinarySessionObservation): void {
      file.assertOpen();
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (bytes.length > 16384) {throw new Error("ordinary_evidence_limit");}
      let offset = 0;
      while (offset < bytes.length) {const wrote = writeSync(fd, bytes, offset); if (wrote <= 0) {throw new Error("ordinary_evidence_write_incomplete");} offset += wrote;}
      fsyncSync(fd);
    },
    close(): void {file.close();},
  });
}
