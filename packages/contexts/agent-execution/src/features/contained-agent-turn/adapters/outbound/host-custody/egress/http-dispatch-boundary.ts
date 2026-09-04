/**
 * Ephemeral handoff, not the durable Host first-byte journal or an operation
 * retry guard. Host Custody still owns that separate durable consumption proof.
 */
export const createHttpDispatchBoundary = (
  bytes: Uint8Array,
  validate: () => boolean,
): Readonly<{
  consume(): Uint8Array | undefined;
  seal(): void;
  wasConsumed(): boolean;
  wasRequested(): boolean;
}> => {
  let open = true;
  let requested = false;
  let consumed = false;
  return Object.freeze({
    consume: () => {
      if (!open || requested) {return;}
      requested = true;
      try {
        if (!validate()) {return;}
      } catch {
        return;
      }
      consumed = true;
      return bytes;
    },
    seal: () => { open = false; bytes.fill(0); },
    wasConsumed: () => consumed,
    wasRequested: () => requested,
  });
};
