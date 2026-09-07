import { LinuxExclusiveRouteOpeningError, openNodeLinuxExclusiveRoute,
  type LinuxExclusiveRouteBinding, type LinuxExclusiveRouteOwner, type LinuxRouteToolPin,
} from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import type { DockerLinuxOperationRouteAdmission } from "./docker-linux-post-claim-preparation.js";

type RouteOpening = Parameters<typeof openNodeLinuxExclusiveRoute>[0];
type Admit = Parameters<DockerLinuxOperationRouteAdmission["admit"]>[0];
type Outcome = Awaited<ReturnType<DockerLinuxOperationRouteAdmission["admit"]>>;

export type DockerLinuxExclusiveRouteAdmissionInput = Readonly<{
  /** The full 21-field route binding. Six of its fields are Provider Access
   * facts; this composition transports them and derives none of them. */
  binding: LinuxExclusiveRouteBinding;
  /** The existing Docker owner's inspection port; no command runner is injectable. */
  engine: RouteOpening["engine"];
  /** Pinned tools from trusted deployment composition, never process.env and
   * never a canary report (`node-linux-exclusive-route.ts` re-verifies both). */
  nsenter: LinuxRouteToolPin;
  nft: LinuxRouteToolPin;
}>;

const refused = Object.freeze({kind: "unsupported" as const, reason: "owner" as const});
const pin = (input: LinuxRouteToolPin): LinuxRouteToolPin => Object.freeze({path: input.path, sha256: input.sha256});

/**
 * Production route admission for the Docker/Linux Codex route: the consumer the
 * Linux exclusive route owner never had. It performs exactly one opening attempt
 * for one launched container, and returns the lease itself so that first-write
 * reservation and revocation stay with the owner rather than with this factory.
 *
 * Every refusal is typed. A non-Linux, non-root or unpinned Host cannot install
 * a route and says so, instead of skipping the gate. A failed opening keeps its
 * namespace descriptors until the exact container is proven absent, which is why
 * release is a separate call the orchestration makes after containment.
 */
export const createDockerLinuxExclusiveRouteAdmission = (
  input: DockerLinuxExclusiveRouteAdmissionInput,
): DockerLinuxOperationRouteAdmission => {
  const binding: LinuxExclusiveRouteBinding = Object.freeze({...input.binding});
  const engine = input.engine;
  const nsenter = pin(input.nsenter);
  const nft = pin(input.nft);
  let entered = false;
  let owner: LinuxExclusiveRouteOwner | undefined;
  let retained: (() => Promise<"quarantined">) | undefined;
  return Object.freeze({
    async admit(request: Admit): Promise<Outcome> {
      if (entered || request.signal.aborted || !Number.isSafeInteger(request.deadlineEpochMs) ||
        Date.now() >= request.deadlineEpochMs) {return refused;}
      entered = true;
      let opened: LinuxExclusiveRouteOwner;
      try {
        opened = await openNodeLinuxExclusiveRoute({authority: request.authority, binding,
          endpoint: request.endpoint, engine, lifetimeMs: request.lifetimeMs, nsenter, nft});
      } catch (error) {
        // A failed opening has already attempted a deny-only cut; its descriptors
        // stay retained until this attempt's exact container is proven absent.
        if (error instanceof LinuxExclusiveRouteOpeningError) {retained = error.releaseAfterContainerRemoval;}
        return refused;
      }
      owner = opened;
      // A cutoff during installation revokes the lease it can no longer use.
      if (request.signal.aborted) {opened.revoke(); return refused;}
      return Object.freeze({kind: "installed" as const, owner: opened});
    },
    async releaseAfterContainerRemoval(): Promise<"closed" | "quarantined" | "none"> {
      if (owner !== undefined) {return owner.releaseAfterContainerRemoval();}
      if (retained !== undefined) {return retained();}
      return "none";
    },
  });
};
