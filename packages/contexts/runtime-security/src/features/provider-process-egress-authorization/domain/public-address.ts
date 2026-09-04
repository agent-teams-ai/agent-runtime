import type { EgressCandidateAddress } from "./provider-process-egress-model.js";

const parseIpv4 = (value: string): readonly number[] | undefined => {
  const parts = value.split(".");
  if (parts.length !== 4) {return undefined;}
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {return undefined;}
    const byte = Number(part);
    if (byte > 255) {return undefined;}
    bytes.push(byte);
  }
  return bytes;
};

const publicIpv4 = (bytes: readonly number[]): boolean => {
  const address = bytes.reduce((value, byte) => value * 256 + byte, 0);
  const deniedRanges = [
    ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"],
    ["100.64.0.0", "100.127.255.255"], ["127.0.0.0", "127.255.255.255"],
    ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
    ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"],
    ["192.88.99.0", "192.88.99.255"],
    ["192.168.0.0", "192.168.255.255"], ["198.18.0.0", "198.19.255.255"],
    ["198.51.100.0", "198.51.100.255"], ["203.0.113.0", "203.0.113.255"],
    ["224.0.0.0", "255.255.255.255"],
  ].map(range => range.map(item =>
    item.split(".").reduce((value, byte) => value * 256 + Number(byte), 0)));
  return !deniedRanges.some(([start = 0, end = 0]) => address >= start && address <= end);
};

const parseIpv6 = (value: string): readonly number[] | undefined => {
  if (value.includes("%") || !/^[0-9a-fA-F:]+$/.test(value)) {return undefined;}
  if ((value.match(/::/g) ?? []).length > 1) {return undefined;}
  const split = value.split("::");
  const left = split[0] === "" ? [] : split[0]?.split(":") ?? [];
  const right = split.length === 1 || split[1] === "" ? [] : split[1]?.split(":") ?? [];
  if ([...left, ...right].some(part => !/^[0-9a-fA-F]{1,4}$/.test(part))) {return undefined;}
  const missing = 8 - left.length - right.length;
  if ((split.length === 1 && missing !== 0) || (split.length === 2 && missing < 1)) {return undefined;}
  const groups = [...left.map(part => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map(part => Number.parseInt(part, 16))];
  return groups.length === 8 ? groups : undefined;
};

const canonicalIpv6 = (groups: readonly number[]): string =>
  groups.map(group => group.toString(16).padStart(4, "0")).join(":");

const specialIpv6 = (groups: readonly number[]): boolean => {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = groups;
  const unspecifiedOrLoopback = groups.slice(0, 7).every(group => group === 0) &&
    (groups[7] === 0 || groups[7] === 1);
  const mapped = a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff;
  return unspecifiedOrLoopback || mapped;
};

const publicIpv6 = (groups: readonly number[]): boolean => {
  const [a = 0, b = 0, c = 0] = groups;
  const globallyRoutable = (a & 0xe000) === 0x2000;
  return globallyRoutable && !(
    specialIpv6(groups) ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xff00) === 0xff00 ||
    (a === 0x2001 && b <= 0x01ff) ||
    (a === 0x2001 && b === 0x0db8) ||
    a === 0x2002 ||
    (a === 0x2620 && b === 0x004f && c === 0x8000) ||
    (a & 0xfff0) === 0x3ff0
  );
};

export const normalizePublicAddress = (
  candidate: EgressCandidateAddress,
): EgressCandidateAddress | undefined => {
  if (candidate.classification !== "public") {return undefined;}
  if (candidate.family === "ipv4") {
    const bytes = parseIpv4(candidate.address);
    if (bytes === undefined || !publicIpv4(bytes)) {return undefined;}
    return { family: "ipv4", address: bytes.join("."), classification: "public" };
  }
  const groups = parseIpv6(candidate.address);
  if (groups === undefined || !publicIpv6(groups)) {return undefined;}
  return { family: "ipv6", address: canonicalIpv6(groups), classification: "public" };
};

export const normalizePublicAddressSet = (
  candidates: readonly EgressCandidateAddress[],
): { readonly addresses: readonly EgressCandidateAddress[]; readonly problem?:
  "address_denied" | "address_duplicate" | "address_set_mixed" } => {
  if (candidates.length === 0 || candidates.length > 32) {return { addresses: [], problem: "address_denied" };}
  const normalized: EgressCandidateAddress[] = [];
  for (const candidate of candidates) {
    const address = normalizePublicAddress(candidate);
    if (address === undefined) {return { addresses: [], problem: "address_denied" };}
    normalized.push(address);
  }
  if (new Set(normalized.map(item => item.family)).size !== 1) {
    return { addresses: [], problem: "address_set_mixed" };
  }
  const identities = normalized.map(item => `${item.family}:${item.address}`);
  if (new Set(identities).size !== identities.length) {
    return { addresses: [], problem: "address_duplicate" };
  }
  return {
    addresses: normalized.toSorted((left, right) =>
      left.address === right.address ? 0 : left.address < right.address ? -1 : 1),
  };
};

export const normalizeObservedAddress = (value: string): string | undefined => {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) {return publicIpv4(ipv4) ? ipv4.join(".") : undefined;}
  const ipv6 = parseIpv6(value);
  return ipv6 !== undefined && publicIpv6(ipv6) ? canonicalIpv6(ipv6) : undefined;
};
