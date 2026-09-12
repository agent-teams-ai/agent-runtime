import type {
  OperationResidueAuthority,
  OperationResidueAuthorityFactory,
} from "./host-custody-cgroup-v2.js";
import type { StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";

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

type CooperativeGroupGuardian = Pick<StableProcessGroupGuardian, "child" | "signalGroup">;

class CooperativeProcessGroupAuthority implements OperationResidueAuthority {
  #guardian: CooperativeGroupGuardian | undefined;
  #pgid: number | undefined;
  #retired = false;
  readonly #observer: PosixProcessGroupObserver;

  public constructor(observer: PosixProcessGroupObserver) {this.#observer = observer;}

  public bindGuardian(guardian: CooperativeGroupGuardian): void {
    if (!this.#retired) {this.#guardian ??= guardian;}
  }

  public async attachGuardian(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || this.#pgid !== undefined || this.#retired) {return false;}
    this.#pgid = pid;
    return true;
  }

  public async close(): Promise<boolean> {
    if (this.#pgid === undefined) {this.#retired = true;}
    return this.#retired;
  }

  public async killAll(): Promise<boolean> {
    if (this.#pgid === undefined || this.#retired) {return true;}
    const guardian = this.#guardian;
    if (guardian === undefined || guardian.child.pid !== this.#pgid) {return false;}
    // The retained IPC channel lets the live guardian signal its own group;
    // a numeric PGID alone cannot authorize a signal after guardian exit.
    return await guardian.signalGroup("SIGKILL") === "sent";
  }

  public async proveEmpty(
    deadline: number,
    monotonicNow: () => number,
  ): Promise<PosixProcessGroupObservation> {
    const pgid = this.#pgid;
    if (pgid === undefined || this.#retired) {return "empty";}
    while (monotonicNow() < deadline) {
      if (this.#retired) {return "empty";}
      const observed = await this.#observer.observe(pgid);
      if (this.#retired) {return "empty";}
      if (observed !== "residue") {
        // Retire this exact group permanently, even though escaped descendants
        // still prevent a physical containment proof on cooperative Darwin.
        if (observed === "empty") {this.#retired = true;}
        return observed;
      }
      await new Promise(resolve => {setTimeout(resolve, Math.min(5, Math.max(1, deadline - monotonicNow())));});
    }
    return this.#retired ? "empty" : "unproven";
  }
}

export const bindCooperativeProcessGroupGuardian = (
  authority: OperationResidueAuthority | undefined,
  guardian: CooperativeGroupGuardian,
): void => {
  if (authority instanceof CooperativeProcessGroupAuthority) {authority.bindGuardian(guardian);}
};

export const createCooperativeProcessGroupAuthorityFactory = (
  observer: PosixProcessGroupObserver = defaultObserver,
): OperationResidueAuthorityFactory => Object.freeze({
  async create() {return new CooperativeProcessGroupAuthority(observer);},
});
