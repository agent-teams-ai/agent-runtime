import type {LiveCustody} from "./node-provider-process-custody-state.js";

export const isLiveCustodySealed = (live: LiveCustody): boolean => live.sealed;
export const isLiveCustodyLaunchOpen = (live: LiveCustody): boolean => !live.sealed && !live.abortRequested;
export const hasLiveCustodyGuardian = (live: LiveCustody): boolean => live.guardian !== undefined;
