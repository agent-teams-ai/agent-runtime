export const DOCKER_LOG_MAX_FRAME_BYTES = 65_536;
export const DOCKER_LOG_MAX_FRAMES = 65_536;
export const DOCKER_LOG_MAX_STREAM_BYTES = 16_777_216;

export interface DockerEngineCall {
  readonly deadlineEpochMs: number;
  readonly signal: AbortSignal;
}

export interface DockerEngineIdentity {
  readonly cgroupDriver: string;
  readonly cgroupVersion: "1" | "2";
  readonly daemonIdentitySha256: string;
  readonly daemonBootGenerationSha256: string;
  readonly engineVersion: string;
  readonly hostIdentitySha256: string;
  readonly hostBootGenerationSha256: string;
  readonly storageDriver: string;
}

export interface DockerContainerAuthority {
  readonly containerId: string;
  readonly daemonIdentitySha256: string;
  readonly daemonBootGenerationSha256: string;
  readonly createSpecificationSha256: string;
  readonly hostIdentitySha256: string;
  readonly hostBootGenerationSha256: string;
  readonly imageDigest: string;
  readonly launchFingerprintSha256: string;
  readonly operationNonceSha256: string;
  readonly ownerIdentitySha256: string;
}

export interface DockerContainerCreate {
  readonly arguments: readonly string[];
  readonly entrypoint: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly imageDigest: string;
  readonly launchFingerprintSha256: string;
  readonly operationNonceSha256: string;
  /** Lifecycle-derived canonical owner binding; never accepted from outer composition. */
  readonly ownerIdentitySha256: string;
  readonly privateRootSource: string;
  readonly workspaceSource: string;
  readonly workspaceWritable: boolean;
}

export interface DockerContainerStateFacts {
  readonly dead: boolean;
  readonly errorPresent: boolean;
  readonly exitCode: number;
  readonly finishedAt: string;
  readonly hostPid: number;
  readonly oomKilled: boolean;
  readonly paused: boolean;
  readonly restarting: boolean;
  readonly running: boolean;
  readonly startedAt: string;
  readonly status: "created" | "dead" | "exited" | "paused" | "removing" | "restarting" | "running";
}

export interface DockerContainerResourceFacts {
  readonly appArmorProfile: string;
  readonly autoRemove: false;
  readonly capabilitiesDropped: "all";
  readonly cgroupNamespaceMode: "private";
  readonly cgroupParent: string;
  readonly containerId: string;
  readonly cpuNanoCpus: number;
  readonly init: true;
  readonly ipcNamespaceMode: "private";
  readonly memoryBytes: number;
  readonly memorySwapBytes: number;
  readonly mountPropagation: "rprivate";
  readonly networkName: string;
  readonly noNewPrivileges: true;
  readonly pidNamespaceMode: "private";
  readonly pidsLimit: number;
  readonly privateRootSourceSha256: string;
  readonly readOnlyRoot: true;
  readonly restart: "disabled";
  readonly seccompProfileSha256: string;
  readonly tmpfsBytes: number;
  readonly user: `${number}:${number}`;
  readonly workspaceSourceSha256: string;
  readonly workspaceWritable: boolean;
  readonly writableLayerBytes: number;
}

export type DockerContainerObservation =
  | {
      readonly authority: DockerContainerAuthority;
      readonly cgroupTree: "unobserved";
      readonly engine: DockerEngineIdentity;
      readonly existence: "present";
      readonly resources: DockerContainerResourceFacts;
      readonly state: DockerContainerStateFacts;
    }
  | {
      readonly authority: DockerContainerAuthority;
      readonly cgroupTree: "unobserved";
      readonly engine: DockerEngineIdentity;
      readonly existence: "absent";
    };

export interface DockerLogFrame {
  readonly bytes: Uint8Array;
  readonly stream: "stderr" | "stdout";
}

/** One pre-start, owner-bound Engine hijack. Docker stream framing is removed here. */
export interface DockerCustodyDuplexChannel {
  readonly output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  closeInput(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
}

export interface DockerEnginePort {
  /** Read-only, generation-stable engine identity used before journal/resource binding. */
  identity(call: DockerEngineCall): Promise<DockerEngineIdentity>;
  create(
    input: DockerContainerCreate,
    call: DockerEngineCall,
    /** When supplied, the adapter must reject generation drift before sending create bytes. */
    expectedIdentity?: DockerEngineIdentity,
  ): Promise<DockerContainerAuthority>;
  /** Opens the sole stdin/stdout custody channel while the exact container is still created, never running. */
  attachCustody(
    authority: DockerContainerAuthority,
    call: DockerEngineCall,
  ): Promise<DockerCustodyDuplexChannel>;
  /** Read-only exact-name/spec reconciliation after a journaled create request. */
  reconcileCreate(input: DockerContainerCreate, call: DockerEngineCall): Promise<DockerContainerAuthority>;
  inspect(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerContainerObservation>;
  kill(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void>;
  logs(authority: DockerContainerAuthority, call: DockerEngineCall): AsyncIterable<DockerLogFrame>;
  remove(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void>;
  start(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void>;
  stop(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void>;
  wait(authority: DockerContainerAuthority, call: DockerEngineCall): Promise<DockerContainerObservation>;
}

export interface DockerEnginePolicy {
  readonly allowedEnvironmentKeys: readonly string[];
  readonly allowedNetworkName: string;
  readonly appArmorProfile: string;
  /** Policy-owned cgroup subtree used for every contained turn. */
  readonly cgroupParent: string;
  readonly cpuNanoCpus: number;
  readonly hostIdentitySha256: string;
  readonly memoryBytes: number;
  readonly pidsLimit: number;
  /** Canonical, policy-owned Docker daemon PID file used to bind the socket to one daemon process generation. */
  readonly daemonPidFilePath: string;
  readonly daemonPidFileOwnerGid: number;
  readonly daemonPidFileOwnerUid: number;
  readonly daemonPidFileMode: number;
  /** Canonical, policy-owned Unix socket endpoint. TCP endpoints are not representable. */
  readonly socketPath: string;
  readonly socketOwnerGid: number;
  readonly socketOwnerUid: number;
  readonly socketMode: number;
  readonly privateRootSourceRoot: string;
  readonly seccompProfileJson: string;
  readonly seccompProfileSha256: string;
  readonly tmpfsBytes: number;
  readonly user: `${number}:${number}`;
  readonly workspaceSourceRoot: string;
  readonly writableLayerBytes: number;
}
