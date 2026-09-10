import assert from "node:assert/strict";
import { hasDarwinHostDescriptors, initializeDarwinHostAcquisitionGuard } from "@agent-teams/filesystem-custody";

initializeDarwinHostAcquisitionGuard();
assert.equal(hasDarwinHostDescriptors(), true);
await import("./host-filesystem-primitives.test.ts");
