import {timingSafeEqual} from "node:crypto";

import type {DockerCustodyIdentity} from "./docker-custody-init-protocol.js";

export const safeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8"); const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};
export const identityEqual = (left: DockerCustodyIdentity, right: DockerCustodyIdentity): boolean =>
  left.protocol === right.protocol && safeEqual(left.containerImageSha256, right.containerImageSha256) &&
  safeEqual(left.initBinarySha256, right.initBinarySha256) && safeEqual(left.privateRootIdentity, right.privateRootIdentity) &&
  safeEqual(left.securityProfileIdentity, right.securityProfileIdentity) && safeEqual(left.workspaceIdentity, right.workspaceIdentity);
export const boundedInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {throw new Error(`${label} must be a positive safe integer`);} return value;
};
export const monotonicNow = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {throw new Error("monotonic clock must return a non-negative safe integer");} return value;
};
export const safeMonotonicDeadline = (now: number, durationMs: number): number =>
  now + Math.min(durationMs, Number.MAX_SAFE_INTEGER - now);
export const opaqueHandle = (value: unknown): value is object =>
  value !== null && (typeof value === "object" || typeof value === "function");
