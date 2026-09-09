import { randomUUID } from "node:crypto";

import type { HostHttpBoundaryIds } from "./http-egress-ports.js";

/** Host lifetime namespace plus a non-reusable, bounded allocation sequence.
 * Retain the returned bundle for the entire attempt, including ambiguous
 * settlement. Calling fresh() is allocation, never recovery or retry.
 */
export class NodeHttpEgressBoundaryIds implements HostHttpBoundaryIds {
  readonly #namespace: string;
  #sequence = 0;

  /** The injectable entropy boundary is private to trusted composition/tests. */
  public constructor(entropy: () => string = randomUUID) {
    const namespace = entropy();
    if (typeof namespace !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(namespace)) {
      throw new TypeError("invalid Host HTTP identity entropy");
    }
    this.#namespace = namespace;
  }

  public fresh(): ReturnType<HostHttpBoundaryIds["fresh"]> {
    if (this.#sequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Host HTTP identity sequence exhausted");
    }
    this.#sequence += 1;
    const prefix = `host-http:${this.#namespace}:${this.#sequence}:`;
    return Object.freeze({
      materializationAuthorizationId: `${prefix}materialization`,
      runtimeAuthorizationId: `${prefix}runtime`,
      boundaryUseId: `${prefix}boundary`,
      connectionAttemptId: `${prefix}connection`,
      streamId: `${prefix}stream`,
    });
  }
}
