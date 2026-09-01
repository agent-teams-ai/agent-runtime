import type {
  OperationResidueAuthority,
  OperationResidueAuthorityFactory,
} from "./host-custody-cgroup-v2.js";

export type PosixProcessGroupObservation = "empty" | "residue" | "unproven";

export interface PosixProcessGroupObserver {
  observe(pgid: number): Promise<PosixProcessGroupObservation>;
}

const defaultObserver: PosixProcessGroupObserver = Object.freeze({
  async observe(pgid: number) {
    try {
      process.kill(-pgid, 0);
      return "residue";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      return code === "ESRCH" ? "empty" : "unproven";
    }
  },
});

const signalGroup = (pgid: number): boolean => {
  try {
    process.kill(-pgid, "SIGKILL");
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
};

class CooperativeProcessGroupAuthority implements OperationResidueAuthority {
  #pgid: number | undefined;
  #provedClosed = false;
  readonly #observer: PosixProcessGroupObserver;

  public constructor(observer: PosixProcessGroupObserver) {this.#observer = observer;}

  public async attachGuardian(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.#pgid !== undefined) {return false;}
    this.#pgid = pid;
    return true;
  }

  public async close(): Promise<boolean> {return this.#pgid === undefined || this.#provedClosed;}

  public async killAll(): Promise<boolean> {
    return this.#pgid === undefined || signalGroup(this.#pgid);
  }

  public async proveEmpty(
    deadline: number,
    monotonicNow: () => number,
  ): Promise<PosixProcessGroupObservation> {
    const pgid = this.#pgid;
    if (pgid === undefined) {return "empty";}
    while (monotonicNow() < deadline) {
      const observed = await this.#observer.observe(pgid);
      if (observed !== "residue") {
        if (observed === "empty") {this.#provedClosed = true;}
        return observed;
      }
      await new Promise(resolve => {setTimeout(resolve, Math.min(5, Math.max(1, deadline - monotonicNow())));});
    }
    return "unproven";
  }
}

export const createCooperativeProcessGroupAuthorityFactory = (
  observer: PosixProcessGroupObserver = defaultObserver,
): OperationResidueAuthorityFactory => Object.freeze({
  async create() {return new CooperativeProcessGroupAuthority(observer);},
});
