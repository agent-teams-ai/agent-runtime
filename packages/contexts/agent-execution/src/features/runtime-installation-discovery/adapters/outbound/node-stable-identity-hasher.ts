import { createHash } from "node:crypto";

import type { StableIdentityHasher } from "../../application/ports/outbound/stable-identity-hashing.js";

export const createNodeStableIdentityHasher = (): StableIdentityHasher => ({
  digest: value => createHash("sha256").update(value).digest("hex"),
});
