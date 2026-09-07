import { randomUUID } from "node:crypto";
import {
  NodeHostPrivateRootOwner, type HostPrivateRootOwner,
} from "../adapters/outbound/filesystem/host-private-root-owner.js";
import { custodyDataRecord } from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import type { DockerKernelReservationCleanup } from "./docker-kernel-host-custody.js";

export type {
  HostPrivateRootBinding, HostPrivateRootOwner, HostPrivateRootReadback,
} from "../adapters/outbound/filesystem/host-private-root-owner.js";

export interface HostPrivateRootCaptureOptions {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly custodyRef: string;
}

const apply = Reflect.apply;
const identity = (value: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\0")) {
    throw new TypeError("Private root Host reservation identity invalid");
  }
  return value;
};

/** Inert private Host factory. Keep one factory per Host incarnation. The
 * generation nonce is allocated by the first explicit capture, not from an
 * observed digest or from an attempt identity. No AE application port is added.
 *
 * The existing preparation cleanup contract is supplied by trusted composition
 * for this exact reservation. Its released result must join physical quiescence
 * and ALL private consumers (including evidence collection/materialization).
 * Do not pass requestContainment itself: it will join this root's cleanup later.
 */
export const createHostPrivateRootOwnerFactory = (input: Readonly<{
  hostInstanceId: string;
  hostBootId: string;
  maximumEntries?: number;
  maximumDepth?: number;
  maximumMilliseconds?: number;
}>) => {
  const data = custodyDataRecord(input);
  const hostInstanceId = identity(data.hostInstanceId);
  const hostBootId = identity(data.hostBootId);
  const maximumEntries = data.maximumEntries ?? 4096;
  const maximumDepth = data.maximumDepth ?? 32;
  const maximumMilliseconds = data.maximumMilliseconds ?? 5000;
  for (const [value, ceiling] of [[maximumEntries, 65536], [maximumDepth, 64], [maximumMilliseconds, 60000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {throw new TypeError("Private root bound invalid");}
  }
  let generation: string | undefined;
  const owners = new Map<string, HostPrivateRootOwner>();
  return Object.freeze({
    /** The Host retains this factory, including unresolved owners and history. */
    get(custodyRef: string): HostPrivateRootOwner | undefined {return owners.get(custodyRef);},
    /** Resource-free construction; capture() performs the filesystem effects.
     * This capability and cleanup owner stay at private Host composition. */
    create(options: HostPrivateRootCaptureOptions, quiescenceOwner: DockerKernelReservationCleanup): HostPrivateRootOwner {
      const reservation = custodyDataRecord(options);
      if (owners.size >= 64) {throw new TypeError("Private root Host retention capacity exhausted");}
      if (owners.has(reservation.custodyRef)) {throw new TypeError("Private root reservation already owned");}
      const quiescence = custodyDataRecord(quiescenceOwner);
      if (typeof quiescence.cutoff !== "function" || typeof quiescence.cleanup !== "function") {
        throw new TypeError("Private root cleanup owner invalid");
      }
      const cutoffMethod = quiescence.cutoff;
      const cleanupMethod = quiescence.cleanup;
      const cutoff: DockerKernelReservationCleanup["cutoff"] = () => apply(cutoffMethod, quiescenceOwner, []);
      const cleanup: DockerKernelReservationCleanup["cleanup"] = call => apply(cleanupMethod, quiescenceOwner, [call]);
      const owner = new NodeHostPrivateRootOwner(Object.freeze({
        rootPath: identity(reservation.rootPath), workspacePath: identity(reservation.workspacePath),
        operationId: identity(reservation.operationId), attemptId: identity(reservation.attemptId), custodyRef: identity(reservation.custodyRef),
        hostInstanceId, hostBootId, maximumEntries, maximumDepth, maximumMilliseconds,
        generation: () => generation ??= randomUUID(),
        async awaitQuiescence(call: Readonly<{ deadlineEpochMs: number }>) {
          cutoff();
          const result = await cleanup(call);
          if (result.kind !== "released") {throw new Error("Private Host cleanup owner has unresolved quiescence debt");}
        },
      }));
      const capability = Object.freeze({capture: owner.capture.bind(owner), revalidate: owner.revalidate.bind(owner),
        snapshot: owner.snapshot.bind(owner), quarantineAndDelete: owner.quarantineAndDelete.bind(owner)});
      owners.set(reservation.custodyRef, capability);
      return capability;
    },
  });
};
