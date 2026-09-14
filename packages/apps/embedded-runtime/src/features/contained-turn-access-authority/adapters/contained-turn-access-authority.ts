import { types } from "node:util";

import type { ContainedTurnAccessAuthority } from "../contracts/contained-turn-access-authority.js";
import { isContainedTurnAccessAuthorityIdentity } from "../contracts/contained-turn-access-authority.js";

const MAX_REVISION_LENGTH = 128;
const MAX_SCOPE_LENGTH = 512;

const isRevision = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_REVISION_LENGTH &&
  /^runtime-access-authority:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);

// Keep the existing application/domain reference limits. Only the private
// authority namespace is reserved; this is not a new project-ID grammar.
const isScopeReference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_SCOPE_LENGTH &&
  !value.includes("\u0000") && !isContainedTurnAccessAuthorityIdentity(value);

const ownDataValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
};

/**
 * Reject proxies before reflection and never invoke getters. Trusted composition
 * supplies scalar authority facts, which are copied once into a frozen record.
 */
export const copyContainedTurnAccessAuthority = (
  value: unknown,
): ContainedTurnAccessAuthority | undefined => {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) {
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || !keys.every(key =>
      key === "authorityRevision" || key === "projectId" || key === "tenantId")) {
      return;
    }
    const authorityRevision = ownDataValue(value, "authorityRevision");
    const projectId = ownDataValue(value, "projectId");
    const tenantId = ownDataValue(value, "tenantId");
    if (!isRevision(authorityRevision) || !isScopeReference(projectId) ||
      !isScopeReference(tenantId)) {
      return;
    }
    return Object.freeze({ authorityRevision, projectId, tenantId });
  } catch {
    return;
  }
};

export const matchesContainedTurnAccessAuthority = (
  value: unknown,
  bound: ContainedTurnAccessAuthority,
): boolean => {
  const snapshot = copyContainedTurnAccessAuthority(value);
  return snapshot !== undefined && snapshot.authorityRevision === bound.authorityRevision &&
    snapshot.projectId === bound.projectId && snapshot.tenantId === bound.tenantId;
};
