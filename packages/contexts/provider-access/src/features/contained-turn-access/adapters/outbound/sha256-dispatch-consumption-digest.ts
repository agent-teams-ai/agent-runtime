import type { DispatchConsumptionDigest } from "../../application/ports/outbound/dispatch-consumption-digest.js";

export const createSha256DispatchConsumptionDigest = (): DispatchConsumptionDigest => Object.freeze({
  async digest(canonicalPayload: string): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalPayload);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
  },
});
