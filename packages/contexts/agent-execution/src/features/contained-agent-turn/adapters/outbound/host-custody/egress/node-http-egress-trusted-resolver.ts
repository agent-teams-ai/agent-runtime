import {types as utilTypes} from "node:util";
import {Resolver} from "node:dns/promises";
import type {HttpEgressClock, HttpEgressTrustedResolver} from "./http-egress-ports.js";
import {boundedHttpOpaque} from "./http-ingress-validation.js";
import {normalizeHttpResolverEvidence} from "./http-egress-resolver-evidence.js";
import {retainHttpEgressClock} from "./http-egress-runtime-security-v2.js";
import {canonicalSni} from "./node-tls-http-egress-transport-support.js";
import {normalizeHttpEgressResolution} from "./public-address-policy.js";

export type NodeHttpEgressDnsBackend = Readonly<{
  resolve4(host: string): Promise<readonly string[]>;
  resolve6(host: string): Promise<readonly string[]>;
  cancel(): void;
}>;
export type NodeHttpEgressTrustedResolverOptions = Readonly<{
  resolverIdentity: string;
  resolverEpoch: string;
  timeoutMs: number;
}>;

// A fresh c-ares channel per observation: no OS lookup fallback or adapter cache.
const nodeBackend = (timeout: number): NodeHttpEgressDnsBackend => new Resolver({timeout, tries: 1});
const noData = (error: unknown): boolean => error instanceof Error
  && Object.getOwnPropertyDescriptor(error, "code")?.value === "ENODATA";

/** A and AAAA form one complete observation; either uncertain family rejects it. */
export class NodeHttpEgressTrustedResolver implements HttpEgressTrustedResolver {
  readonly #options: NodeHttpEgressTrustedResolverOptions;
  readonly #clock: HttpEgressClock;
  readonly #backend: (timeout: number) => NodeHttpEgressDnsBackend;

  public constructor(options: NodeHttpEgressTrustedResolverOptions, clock: HttpEgressClock,
    backend: (timeout: number) => NodeHttpEgressDnsBackend = nodeBackend) {
    if (!boundedHttpOpaque(options.resolverIdentity) || !boundedHttpOpaque(options.resolverEpoch)
      || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000) {
      throw new Error("invalid_dns_configuration");
    }
    this.#options = Object.freeze({...options});
    this.#clock = retainHttpEgressClock(clock);
    this.#backend = backend;
  }

  public async resolve(host: string) {
    if (canonicalSni(host) === undefined) {throw new Error("invalid_dns_host");}
    const start = this.#clock.now();
    const deadline = start + this.#options.timeoutMs;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(deadline)) {
      throw new Error("invalid_dns_clock");
    }
    const backend = this.#backend(this.#options.timeoutMs);
    try {
      const resolution = await this.#clock.within(deadline, async () => {
        const family = async (read: () => Promise<readonly string[]>, ipv6: boolean) => {
          let values: readonly string[];
          try {values = await read();} catch (error) {
            if (noData(error)) {return [];}
            throw new Error("dns_incomplete", {cause: error});
          }
          // Validate each complete family before combining; never truncate or filter.
          const selected = Array.isArray(values) && !utilTypes.isProxy(values)
            ? Object.getOwnPropertyDescriptor(values, "0")?.value : undefined;
          const normalized = normalizeHttpEgressResolution(values, selected);
          if (normalized === undefined || normalized.addresses.some(address => address.includes(":") !== ipv6)) {
            throw new Error("dns_invalid_addresses");
          }
          return normalized.addresses;
        };
        const [v4, v6] = await Promise.all([
          family(() => backend.resolve4(host), false), family(() => backend.resolve6(host), true),
        ]);
        const addresses = [...v4, ...v6].toSorted();
        const observation = normalizeHttpResolverEvidence({
          resolverIdentity: this.#options.resolverIdentity, resolverEpoch: this.#options.resolverEpoch,
          resolutionCount: 1, selectedAddress: addresses[0],
          addresses: addresses.map(address => ({address, family: address.includes(":") ? "ipv6" : "ipv4",
            classification: "public"})),
        });
        if (observation === undefined) {throw new Error("dns_invalid_addresses");}
        return observation;
      });
      const now = this.#clock.now();
      if (!Number.isSafeInteger(now) || now < start || now >= deadline) {throw new Error("dns_deadline");}
      return resolution;
    } finally {
      backend.cancel();
    }
  }
}
