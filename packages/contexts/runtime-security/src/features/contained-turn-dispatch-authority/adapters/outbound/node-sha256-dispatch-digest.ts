import { createHash } from "node:crypto";

import type { DispatchDigest } from "../../application/ports/outbound/dispatch-digest.js";

export const createNodeSha256DispatchDigest = (): DispatchDigest => ({
  digestCanonical(canonicalValue) {
    return `sha256:${createHash("sha256").update(canonicalValue, "utf8").digest("hex")}`;
  },
});
