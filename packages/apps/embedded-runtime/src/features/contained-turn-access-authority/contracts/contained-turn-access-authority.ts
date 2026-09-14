/** Composition-only authority; never an operation CAS or a caller DTO. */
export interface ContainedTurnAccessAuthority {
  readonly authorityRevision: string;
  readonly projectId: string;
  readonly tenantId: string;
}

const REVISION_PREFIX = "runtime-access-authority:";

/** This namespace must also be excluded from identities projected to callers. */
export const isContainedTurnAccessAuthorityIdentity = (value: unknown): boolean =>
  typeof value === "string" && value.includes(REVISION_PREFIX);
