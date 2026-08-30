import { createHash } from "node:crypto";
import type { DispatchConsumptionDigest } from "../../application/ports/outbound/dispatch-consumption-digest.js";

export const createSha256DispatchConsumptionDigest = (): DispatchConsumptionDigest => Object.freeze({
  async digest(canonicalPayload: string): Promise<string> {
    return `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`;
  },
});
