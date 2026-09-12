import type {DockerContainedTurnInitOptions, DockerContainedTurnInitSession} from "./docker-contained-turn-host-custody.js";
import type {DockerHostCustodyLifecycle} from "./docker-host-custody-lifecycle.js";
import type {DockerCustodyInitHostExec} from "./init/docker-custody-init-host-session.js";
import type {DockerContainerAuthority, DockerEngineCall} from "./engine/docker-engine-port.js";
import type {DockerCustodyJournalRecord} from "./journal/docker-custody-journal-types.js";

export type LaunchedDockerCustody = Awaited<ReturnType<DockerHostCustodyLifecycle["launch"]>>;
export interface ProviderProcessLaunch {
  readonly authority: DockerContainerAuthority;
  readonly custodyRef: string;
  readonly workspaceAuthorityPath: string;
  readonly mountFacts: Readonly<{workspaceSource: string; privateRootSource: string; imageDigest: string}>;
  openInitSession(options: DockerContainedTurnInitOptions): DockerContainedTurnInitSession;
  execute(exec: DockerCustodyInitHostExec, call: DockerEngineCall): Promise<DockerCustodyJournalRecord>;
}
/** Each factory call has independent custody; consumers cannot reach the lifecycle's issuer. */
export const createDockerProviderProcessLaunchIssuer = () => {
  const issued = new WeakMap<LaunchedDockerCustody, Readonly<{process: ProviderProcessLaunch; assertActive(): void}>>();
  const claimed = new WeakMap<ProviderProcessLaunch, () => void>();
  const seen = new WeakSet<LaunchedDockerCustody>();
  return Object.freeze({
    issue(launch: LaunchedDockerCustody, process: ProviderProcessLaunch, assertActive: () => void): void {
      if (seen.has(launch)) {throw new TypeError("Docker launch capability cannot be reissued");}
      seen.add(launch); issued.set(launch, Object.freeze({process: Object.freeze(process), assertActive}));
    },
    /** Validate preparation without consuming the later provider execution claim. */
    prepare(launch: LaunchedDockerCustody): Omit<ProviderProcessLaunch, "execute"> {
      const entry = issued.get(launch);
      if (entry === undefined) {throw new TypeError("Docker provider process requires an unused actual lifecycle launch");}
      entry.assertActive();
      const {authority, custodyRef, workspaceAuthorityPath, mountFacts, openInitSession} = entry.process;
      return Object.freeze({authority, custodyRef, workspaceAuthorityPath, mountFacts, openInitSession});
    },
    /** Read-only facts of an unused actual launch; this does not consume IO custody. */
    mountFacts(launch: LaunchedDockerCustody) {
      const entry = issued.get(launch);
      if (entry === undefined) {throw new TypeError("Docker mount projection requires an unused actual launch");}
      entry.assertActive(); return entry.process.mountFacts;
    },
    /** Retained admission check cannot mint another execution claim. */
    assertClaimActive(process: ProviderProcessLaunch): void {
      const assertActive = claimed.get(process);
      if (assertActive === undefined) {throw new TypeError("Docker process claim is not owned by this issuer");}
      assertActive();
    },
    /** Historical observation never grants fresh dispatch authority. */
    claim(launch: LaunchedDockerCustody): ProviderProcessLaunch {
      const entry = issued.get(launch);
      if (entry === undefined) {throw new TypeError("Docker provider process requires an unused actual lifecycle launch");}
      entry.assertActive(); issued.delete(launch);
      claimed.set(entry.process, entry.assertActive); return entry.process;
    },
  });
};
