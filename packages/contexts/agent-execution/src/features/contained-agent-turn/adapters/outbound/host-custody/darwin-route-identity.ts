import type { DarwinSeatbeltRouteOwner } from "./darwin-seatbelt-route-owner.js";

// Nominal private issuance only, with no platform/storage initialization on the
// established Linux reservation path. This is not a resource or cleanup registry.
const issued = new WeakSet<object>();
export const issueDarwinRouteIdentity = (owner: DarwinSeatbeltRouteOwner): void => {issued.add(owner);};
export const isIssuedDarwinRouteOwner = (value: object): value is DarwinSeatbeltRouteOwner => issued.has(value);
