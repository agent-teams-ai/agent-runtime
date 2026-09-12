const MAX_IDENTITY_LENGTH = 512;

declare const hostHttpAdmissionLeaseBrand: unique symbol;

export type HostHttpAdmissionLease = Readonly<{
  [hostHttpAdmissionLeaseBrand]: "host-http-admission-lease";
}>;

export type HostHttpReservationIdentity = Readonly<{
  operationId: string;
  attemptId: string;
  custodyId: string;
  hostGeneration: string;
  liveProcessSessionIdentity: object;
}>;

export type HostHttpCompleteSuccess = Readonly<{
  response: "observed_policy_accepted";
  delivery: "delivered";
  upstreamClosure: "closed";
  inboundClosure: "closed";
  evidenceAcknowledgement: "acknowledged";
}>;

export type HostHttpAdmissionSnapshot = Readonly<{
  state: "available" | "active" | "closed";
  closePending: boolean;
}>;

export type HostHttpAdmissionGuard = Readonly<{
  acquire(): HostHttpAdmissionLease | undefined;
  finish(lease: unknown, disposition: unknown): "available" | "closed" | "rejected";
  invalidate(lease: unknown): "closed" | "pending";
  close(): void;
  snapshot(): HostHttpAdmissionSnapshot;
}>;

type DataRecord = Readonly<Record<string, PropertyDescriptor>>;

const descriptorsOf = (value: unknown): DataRecord | undefined => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {return undefined;}
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {return undefined;}
    return Object.getOwnPropertyDescriptors(value) as DataRecord;
  } catch {
    return undefined;
  }
};

const exactData = (
  value: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | undefined => {
  const descriptors = descriptorsOf(value);
  if (descriptors === undefined) {return undefined;}
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor)) {return undefined;}
    snapshot[field] = descriptor.value;
  }
  return Object.freeze(snapshot);
};

const boundedIdentity = (value: unknown): value is string => typeof value === "string"
  && value.length > 0 && value.length <= MAX_IDENTITY_LENGTH
  && !/\p{Cc}|\p{Cs}/u.test(value);

const snapshotReservation = (value: unknown): HostHttpReservationIdentity | undefined => {
  const record = exactData(value, [
    "operationId", "attemptId", "custodyId", "hostGeneration", "liveProcessSessionIdentity",
  ]);
  if (record === undefined || !boundedIdentity(record.operationId) || !boundedIdentity(record.attemptId)
    || !boundedIdentity(record.custodyId) || !boundedIdentity(record.hostGeneration)
    || (typeof record.liveProcessSessionIdentity !== "object" || record.liveProcessSessionIdentity === null)) {
    return undefined;
  }
  return Object.freeze({
    operationId: record.operationId,
    attemptId: record.attemptId,
    custodyId: record.custodyId,
    hostGeneration: record.hostGeneration,
    liveProcessSessionIdentity: record.liveProcessSessionIdentity,
  });
};

const isCompleteSuccess = (value: unknown): value is HostHttpCompleteSuccess => {
  const record = exactData(value, [
    "response", "delivery", "upstreamClosure", "inboundClosure", "evidenceAcknowledgement",
  ]);
  return record !== undefined
    && record.response === "observed_policy_accepted"
    && record.delivery === "delivered"
    && record.upstreamClosure === "closed"
    && record.inboundClosure === "closed"
    && record.evidenceAcknowledgement === "acknowledged";
};

export const createHostHttpAdmissionGuard = (identity: unknown): HostHttpAdmissionGuard => {
  const reservation = snapshotReservation(identity);
  if (reservation === undefined) {throw new TypeError("invalid Host HTTP reservation identity");}

  let state: HostHttpAdmissionSnapshot["state"] = "available";
  let activeLease: HostHttpAdmissionLease | undefined;
  let closePending = false;

  const sealWithoutDisplacingActive = (): "closed" | "pending" => {
    if (state === "active") {
      closePending = true;
      return "pending";
    }
    state = "closed";
    activeLease = undefined;
    closePending = false;
    return "closed";
  };

  return Object.freeze({
    acquire: (): HostHttpAdmissionLease | undefined => {
      // Retain the exact immutable Host binding for the guard's entire lifetime.
      void reservation;
      if (state !== "available") {return undefined;}
      const lease = Object.freeze(Object.create(null)) as HostHttpAdmissionLease;
      activeLease = lease;
      state = "active";
      return lease;
    },
    finish: (lease: unknown, disposition: unknown): "available" | "closed" | "rejected" => {
      if (state !== "active" || lease !== activeLease) {
        sealWithoutDisplacingActive();
        return "rejected";
      }
      const completeSuccess = isCompleteSuccess(disposition);
      // Reflecting over a hostile disposition may synchronously reenter this guard.
      // Treat that validation as an authority boundary and revalidate the exact lease
      // before changing any state established by a nested call.
      if (state !== "active" || lease !== activeLease) {
        sealWithoutDisplacingActive();
        return "rejected";
      }
      if (!completeSuccess || closePending) {
        activeLease = undefined;
        state = "closed";
        closePending = false;
        return "closed";
      }
      activeLease = undefined;
      state = "available";
      return "available";
    },
    invalidate: (lease: unknown): "closed" | "pending" => {
      if (state === "active" && lease === activeLease) {
        activeLease = undefined;
        state = "closed";
        closePending = false;
        return "closed";
      }
      return sealWithoutDisplacingActive();
    },
    close: (): void => {
      activeLease = undefined;
      state = "closed";
      closePending = false;
    },
    snapshot: (): HostHttpAdmissionSnapshot => Object.freeze({state, closePending}),
  });
};
