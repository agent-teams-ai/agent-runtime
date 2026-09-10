import {initializeDarwinHostAcquisitionGuard} from "@agent-teams/filesystem-custody";

initializeDarwinHostAcquisitionGuard();

const {runDarwinPublicRuntimeHostChild} = await import("./full-public-runtime.mjs");
await runDarwinPublicRuntimeHostChild();
