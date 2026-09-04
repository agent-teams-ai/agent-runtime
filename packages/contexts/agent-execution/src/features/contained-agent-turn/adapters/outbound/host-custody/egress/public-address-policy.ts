const parseIpv4 = (address: string): readonly number[] | undefined => {
  const parts = address.split(".");
  if (parts.length !== 4) {return undefined;}
  const octets = parts.map(part => /^(0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : -1);
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : undefined;
};

const blockedIpv4Ranges: readonly Readonly<{ network: number; mask: number }>[] = [
  { network: 0x0000_0000, mask: 0xff00_0000 },
  { network: 0x0a00_0000, mask: 0xff00_0000 },
  { network: 0x6440_0000, mask: 0xffc0_0000 },
  { network: 0x7f00_0000, mask: 0xff00_0000 },
  { network: 0xa9fe_0000, mask: 0xffff_0000 },
  { network: 0xac10_0000, mask: 0xfff0_0000 },
  { network: 0xc000_0000, mask: 0xffff_ff00 },
  { network: 0xc000_0200, mask: 0xffff_ff00 },
  { network: 0xc058_6300, mask: 0xffff_ff00 },
  { network: 0xc0a8_0000, mask: 0xffff_0000 },
  { network: 0xc0af_3000, mask: 0xffff_ff00 },
  { network: 0xc612_0000, mask: 0xfffe_0000 },
  { network: 0xc633_6400, mask: 0xffff_ff00 },
  { network: 0xcb00_7100, mask: 0xffff_ff00 },
  { network: 0xe000_0000, mask: 0xe000_0000 },
];

const isPublicIpv4 = (octets: readonly number[]): boolean => {
  const value = octets.reduce((address, octet) => ((address << 8) | octet) >>> 0, 0);
  return !blockedIpv4Ranges.some(range => (value & range.mask) >>> 0 === range.network);
};

const expandIpv6 = (address: string): readonly number[] | undefined => {
  if (address.includes("%") || address.includes(".")) {return undefined;}
  if ((address.match(/::/g) ?? []).length > 1) {return undefined;}
  const halves = address.toLowerCase().split("::");
  const left = halves[0]?.length === 0 ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length < 2 || halves[1]?.length === 0 ? [] : halves[1]?.split(":") ?? [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) {return undefined;}
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {return undefined;}
  const words = [...left.map(part => Number.parseInt(part, 16)), ...Array.from({ length: missing }, () => 0), ...right.map(part => Number.parseInt(part, 16))];
  return words.length === 8 ? words : undefined;
};

const isPublicIpv6 = (words: readonly number[]): boolean => {
  const [first, second] = words as [number, number, ...number[]];
  // Strictly admit global-unicast 2000::/3, excluding documentation and reserved subranges.
  if ((first & 0xe000) !== 0x2000) {return false;}
  // 6to4 exposes an embedded IPv4 route that can bypass the IPv4 deny ranges.
  if (first === 0x2002) {return false;}
  if (first === 0x2001 && second === 0x0db8) {return false;}
  if (first === 0x2001 && (second === 0 || second === 2 || (second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) {return false;}
  if (first === 0x3fff) {return false;}
  return true;
};

const canonicalIpv6 = (words: readonly number[]): string => {
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < words.length;) {
    if (words[start] !== 0) {start += 1; continue;}
    let end = start;
    while (end < words.length && words[end] === 0) {end += 1;}
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const formatted = words.map(word => word.toString(16));
  if (bestStart < 0) {return formatted.join(":");}
  return `${formatted.slice(0, bestStart).join(":")}::${formatted.slice(bestStart + bestLength).join(":")}`;
};

const normalizePublicAddress = (address: string): string | undefined => {
  if (address.length === 0 || address.length > 64) {return undefined;}
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {return isPublicIpv4(ipv4) ? ipv4.join(".") : undefined;}
  const ipv6 = expandIpv6(address);
  return ipv6 !== undefined && isPublicIpv6(ipv6) ? canonicalIpv6(ipv6) : undefined;
};

export const isPublicEgressAddress = (address: string): boolean => {
  return normalizePublicAddress(address) !== undefined;
};

export type NormalizedHttpEgressResolution = Readonly<{
  addresses: readonly string[];
  selectedAddress: string;
}>;

export const normalizeHttpEgressResolution = (
  addresses: readonly string[],
  selectedAddress: string,
): NormalizedHttpEgressResolution | undefined => {
  if (addresses.length === 0 || addresses.length > 32) {return undefined;}
  const normalizedSelected = normalizePublicAddress(selectedAddress);
  if (normalizedSelected === undefined) {return undefined;}
  const normalized = addresses.map(normalizePublicAddress);
  if (normalized.some(address => address === undefined)) {return undefined;}
  const exact = normalized as string[];
  if (new Set(exact).size !== exact.length || !exact.includes(normalizedSelected)) {return undefined;}
  return Object.freeze({
    addresses: Object.freeze(exact.toSorted()),
    selectedAddress: normalizedSelected,
  });
};

export const resolutionIsSafe = (
  addresses: readonly string[],
  selectedAddress: string,
): boolean => addresses.length > 0
  && normalizeHttpEgressResolution(addresses, selectedAddress) !== undefined;
