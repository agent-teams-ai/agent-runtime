import type { PreparedHttpRequestCustodyV1 } from "./prepared-http-request-v1.js";

/**
 * Ephemeral handoff, not the durable Host first-byte journal or an operation
 * retry guard. Host Custody still owns that separate durable consumption proof.
 */
export const createHttpDispatchBoundary = (
  custody: Pick<PreparedHttpRequestCustodyV1, "wireBytes" | "dispose">,
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
    consume: (): Uint8Array | undefined => {
      if (!open || requested) {return undefined;}
      requested = true;
      try {
        if (!validate()) {return undefined;}
      } catch {
        return undefined;
      }
      consumed = true;
      return custody.wireBytes;
    },
    seal: () => { if (!open) {return;} open = false; custody.dispose(); },
    wasConsumed: () => consumed,
    wasRequested: () => requested,
  });
};
