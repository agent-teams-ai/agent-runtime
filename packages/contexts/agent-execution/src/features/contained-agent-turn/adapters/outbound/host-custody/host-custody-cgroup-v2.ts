import { HostCustodyUnsupportedError } from "./custodied-provider-process.js";

export interface OperationResidueAuthority {
  attachGuardian(pid: number): Promise<boolean>;
  close(): Promise<boolean>;
  killAll(): Promise<boolean>;
  proveEmpty(deadline: number, monotonicNow: () => number): Promise<"empty" | "residue" | "unproven">;
}

export interface OperationResidueAuthorityFactory {
  create(custodyRef: string): Promise<OperationResidueAuthority>;
}

// Same-uid cgroup delegation cannot contain a hostile child: the child can
// move itself back to a writable ancestor. A qualified outer adapter must
// place the guardian in a protected operation cgroup/container before it is
// allowed to exec the provider and must retain descriptor-bound residue
// authority. Until composition supplies that adapter, strict Linux custody is
// explicitly unsupported.
export const unsupportedOperationResidueAuthorityFactory: OperationResidueAuthorityFactory = Object.freeze({
  async create() {
    throw new HostCustodyUnsupportedError("linux-cgroup-v2-unavailable");
  },
});
