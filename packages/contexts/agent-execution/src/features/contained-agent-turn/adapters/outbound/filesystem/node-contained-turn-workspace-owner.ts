import { openBoundDirectories } from "./contained-turn-filesystem-handles.js";
import { readStableFileAt } from "./contained-turn-durable-file.js";
import { revalidateBoundRoots, type BoundContainedTurnRoot } from "./contained-turn-filesystem-custody.js";
import {
  closeWorkspaceHandles, sameScope, workspaceName, workspaceRecordBytes,
  type ContainedTurnWorkspaceContext, type SelectedNativeWorkspaceBackend,
} from "./contained-turn-workspace-io.js";
import {
  parseWorkspaceCreationRecord, parseWorkspaceSealRecord, parseWorkspaceClosureRecord,
} from "./contained-turn-workspace-state.js";
import { parseResultPublicationRecord } from "./contained-turn-result-publication.js";
import type { ContainedTurnArtifactSealingContext } from "./contained-turn-artifact-sealing.js";
import type { DarwinNativeWorkspaceSelection } from "./darwin-attempt-workspace-backend.js";
import type { ContainedTurnKernelWorkspacePort } from
  "../../../application/ports/outbound/contained-turn-ports.js";
import type {
  ContainedTurnAttemptId,
  ContainedTurnOperationId,
  ContainedTurnWorkspaceId,
} from "../../../domain/contained-turn-identities.js";
import {
  createWorkspaceCapabilityRetention,
  type ResolvedWorkspaceLaunchAuthority,
} from "./contained-turn-workspace-capability.js";
import {
  createNodeContainedTurnWorkspaceOwnerBackend,
  type NodeContainedTurnWorkspaceOptions,
} from "./node-contained-turn-workspace.js";

const OWNER_DISPOSAL_COMPLETION_BOUND_MS = 1_000;

export interface NodeContainedTurnWorkspaceOwner {
  readonly dispose: () => Promise<void>;
  readonly withLaunchAuthority: <Result>(
    input: Readonly<{
      attemptId: ContainedTurnAttemptId;
      operationId: ContainedTurnOperationId;
      workspaceId: ContainedTurnWorkspaceId;
    }>,
    consume: (target: ResolvedWorkspaceLaunchAuthority) => Promise<Result>,
  ) => Promise<Result>;
  readonly workspace: ContainedTurnKernelWorkspacePort;
}

type LaunchInput = Parameters<NodeContainedTurnWorkspaceOwner["withLaunchAuthority"]>[0];
type NativeArtifactSource = NonNullable<ContainedTurnArtifactSealingContext["nativeSource"]>;
type ClosureInput = Readonly<{operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId}>;
interface OwnerPrivateFacts {
  readonly readNativeReceipts: (input: ClosureInput) => ReturnType<SelectedNativeWorkspaceBackend["readReceipts"]>;
  readonly readNativeClosure: (input: ClosureInput) => ReturnType<SelectedNativeWorkspaceBackend["readClosed"]>;
  readonly native: boolean;
  readonly attachArtifacts: (
    roots: ContainedTurnArtifactSealingContext["workspaceRoots"],
    results: BoundContainedTurnRoot,
  ) => Promise<NativeArtifactSource | undefined>;
  readonly consumeNative: <Result>(
    input: LaunchInput,
    consume: (selection: DarwinNativeWorkspaceSelection) => Promise<Result>,
  ) => Promise<Result>;
}
const issuedOwners = new WeakMap<object, OwnerPrivateFacts>();

/** Non-consuming custody discriminator; only privately registered owners qualify. */
export const isNodeContainedTurnNativeWorkspaceOwner = (
  value: object,
): value is NodeContainedTurnWorkspaceOwner => issuedOwners.get(value)?.native === true;

/** Adapter-private handoff: a structural clone never selects native artifact custody. */
export const attachNodeContainedTurnWorkspaceArtifacts = (
  owner: NodeContainedTurnWorkspaceOwner,
  roots: ContainedTurnArtifactSealingContext["workspaceRoots"],
  results: BoundContainedTurnRoot,
): Promise<NativeArtifactSource | undefined> => {
  const facts = issuedOwners.get(owner);
  if (facts === undefined) {throw new Error("contained turn artifact workspace owner is not issued");}
  return facts.attachArtifacts(roots, results);
};

/** Namespace composition consumes the issued selection; no filesystem descriptor is fabricated. */
export const withNodeContainedTurnNativeWorkspaceSelection = <Result>(
  owner: NodeContainedTurnWorkspaceOwner,
  input: LaunchInput,
  consume: (selection: DarwinNativeWorkspaceSelection) => Promise<Result>,
): Promise<Result> => {
  const facts = issuedOwners.get(owner);
  if (facts === undefined) {throw new Error("contained turn native workspace owner is not issued");}
  return facts.consumeNative(input, consume);
};

/** Issued owner only; the native backend requires a genuine RELEASED grant. */
export const readNodeContainedTurnNativeWorkspaceClosure = (
  owner: NodeContainedTurnWorkspaceOwner, input: ClosureInput,
): ReturnType<SelectedNativeWorkspaceBackend["readClosed"]> => {
  const facts = issuedOwners.get(owner);
  if (!facts?.native) {throw new Error("contained turn native workspace owner is not issued");}
  return facts.readNativeClosure(input);
};

/** Durable creation/seal/publication readback of this issued native owner.
 * Caller records, paths and receipt codecs are absent. Closure is verified separately. */
export const readNodeContainedTurnNativeWorkspaceReceipts = (
  owner: NodeContainedTurnWorkspaceOwner, input: ClosureInput,
): ReturnType<SelectedNativeWorkspaceBackend["readReceipts"]> => {
  const facts = issuedOwners.get(owner);
  if (!facts?.native) {throw new Error("contained turn native workspace owner is not issued");}
  return facts.readNativeReceipts(Object.freeze({...input}));
};

const once = (mutation: () => Promise<void>): (() => Promise<void>) => {
  let outcome: Promise<void> | undefined;
  return () => outcome ??= Promise.resolve().then(mutation);
};

const createNativeOwnerState = (options: NodeContainedTurnWorkspaceOptions) => {
  let nativeContext: ContainedTurnWorkspaceContext | undefined;
  let native: SelectedNativeWorkspaceBackend | undefined;
  let nativeRequest: Parameters<ContainedTurnKernelWorkspacePort["create"]>[0] | undefined;
  let resultPublications: BoundContainedTurnRoot | undefined;
  const readOwnedRecord = async (root: BoundContainedTurnRoot): Promise<Buffer> => {
    if (nativeRequest === undefined || nativeContext === undefined) {
      throw new Error("contained turn native workspace has no retained creation request");
    }
    await revalidateBoundRoots(nativeContext.custodyRoots);
    const [directory] = await openBoundDirectories([root]);
    try {
      return await readStableFileAt(directory,
        `${workspaceName(nativeRequest.operationId, nativeRequest.scope)}.json`, workspaceRecordBytes);
    } finally {await closeWorkspaceHandles([directory]);}
  };
  let frozen: ReturnType<NativeArtifactSource["freeze"]> | undefined;
  const initialize = async (context: ContainedTurnWorkspaceContext): Promise<SelectedNativeWorkspaceBackend> => {
    nativeContext = context;
    const { selectDarwinAttemptWorkspaceBackend } = await import("./darwin-attempt-workspace-backend.js");
    const selected = selectDarwinAttemptWorkspaceBackend(options.selectedNativeWorkspace!, {
      creation: async () => parseWorkspaceCreationRecord(await readOwnedRecord(context.roots.creations)),
      seal: async () => parseWorkspaceSealRecord(await readOwnedRecord(context.roots.seals)),
      closure: async () => parseWorkspaceClosureRecord(await readOwnedRecord(context.roots.receipts)),
      artifactResult: async () => {
        if (resultPublications === undefined) {
          throw new Error("contained turn native artifact result owner has not attached");
        }
        return parseResultPublicationRecord(await readOwnedRecord(resultPublications));
      },
    });
    native = Object.freeze({
      ...selected,
      acknowledgeClosure: once(() => selected.acknowledgeClosure()),
      cleanup: once(() => selected.cleanup()),
      close: once(() => selected.close()),
      commitCreation: once(() => selected.commitCreation()),
      quarantine: once(() => selected.quarantine()),
    });
    return native;
  };
  const attachArtifacts = async (
    roots: ContainedTurnArtifactSealingContext["workspaceRoots"], results: BoundContainedTurnRoot,
    assertOpen: () => void, ownsOperation: (operationId: ContainedTurnOperationId) => boolean,
  ): Promise<NativeArtifactSource | undefined> => {
    assertOpen();
    if (nativeContext === undefined || native === undefined) {
      // Still authenticate the ordinary owner instance before allowing legacy behavior.
      if (roots.active.canonicalPath !== `${options.root}/active`) {
        throw new Error("contained turn artifact workspace root belongs to another owner");
      }
      return;
    }
    await revalidateBoundRoots(nativeContext.custodyRoots);
    for (const key of ["active", "creations", "frozen", "receipts", "seals", "staging"] as const) {
      const owned = nativeContext.roots[key];
      const candidate = roots[key];
      if (owned.canonicalPath !== candidate.canonicalPath ||
        owned.identity.dev !== candidate.identity.dev || owned.identity.ino !== candidate.identity.ino) {
        throw new Error("contained turn native artifact storage root belongs to another owner");
      }
    }
    if (resultPublications !== undefined) {
      throw new Error("contained turn native artifact result owner is already attached");
    }
    resultPublications = results;
    const selected = native;
    return Object.freeze<NativeArtifactSource>({
      freeze: async request => {
        assertOpen();
        if (nativeRequest === undefined || nativeRequest.operationId !== request.operationId ||
          !sameScope(nativeRequest.scope, request.scope) ||
          !ownsOperation(nativeRequest.operationId)) {
          throw new Error("contained turn native artifact request is not owned by this workspace owner");
        }
        return frozen ??= Promise.resolve().then(() => selected.freeze());
      },
    });
  };
  return {
    attachArtifacts,
    initialize: options.selectedNativeWorkspace === undefined ? undefined : initialize,
    get native() {return native;},
    reserve(input: Parameters<ContainedTurnKernelWorkspacePort["create"]>[0]) {
      if (native === undefined) {return input;}
      if (nativeRequest !== undefined && (nativeRequest.operationId !== input.operationId ||
        !sameScope(nativeRequest.scope, input.scope))) {
        throw new Error("contained turn native selection is already reserved by another creation request");
      }
      return nativeRequest ??= Object.freeze({ ...input, scope: Object.freeze({ ...input.scope }) });
    },
  };
};

const initializeOwnerBackend = async (options: NodeContainedTurnWorkspaceOptions,
  retention: ReturnType<typeof createWorkspaceCapabilityRetention>, nativeState: ReturnType<typeof createNativeOwnerState>) => {
  try {return await createNodeContainedTurnWorkspaceOwnerBackend(options, retention, nativeState.initialize);}
  catch (error) {await retention.dispose(); throw error;}
};
const nativeClosureReader = (native: SelectedNativeWorkspaceBackend | undefined,
  operations: ReadonlyMap<ContainedTurnOperationId, ContainedTurnWorkspaceId>,
  workspaces: ReadonlyMap<ContainedTurnWorkspaceId, ContainedTurnOperationId>) => async (input: ClosureInput) => {
  if (!native || operations.get(input.operationId) !== input.workspaceId || workspaces.get(input.workspaceId) !== input.operationId) {
    throw new Error("contained turn native closure identity is not owned by this owner");
  }
  return native.readClosed();
};

const nativeReceiptReader = (native: SelectedNativeWorkspaceBackend | undefined,
  assertOpen: () => void, assertIdentity: (input: ClosureInput) => void) => async (input: ClosureInput) => {
  assertOpen();
  assertIdentity(input);
  if (native === undefined) {throw new Error("contained turn native workspace owner is not issued");}
  const receipts = await native.readReceipts();
  assertOpen();
  return receipts;
};

const captureOwnerOptions = (configuration: NodeContainedTurnWorkspaceOptions) => Object.freeze({ ...configuration,
  ...(configuration.limits === undefined ? {} : { limits: Object.freeze({ ...configuration.limits }) }) });

export const createNodeContainedTurnWorkspaceOwner = async (
  configuration: NodeContainedTurnWorkspaceOptions,
): Promise<NodeContainedTurnWorkspaceOwner> => {
  const options = captureOwnerOptions(configuration);
  const darwinWorkspace = options.selectedNativeWorkspace === undefined ? undefined :
    await import("./darwin-attempt-workspace-backend.js");
  const retention = createWorkspaceCapabilityRetention(), nativeState = createNativeOwnerState(options);
  const backend = await initializeOwnerBackend(options, retention, nativeState);

  let disposed = false, disposal: Promise<void> | undefined;
  const ownedOperations = new Map<ContainedTurnOperationId, ContainedTurnWorkspaceId>();
  const ownedWorkspaces = new Map<ContainedTurnWorkspaceId, ContainedTurnOperationId>();
  const consumedAttempts = new Set<ContainedTurnAttemptId>();
  const consumedWorkspaces = new Set<ContainedTurnWorkspaceId>();
  const activeLaunches = new Set<Promise<unknown>>();
  const kernelWorkspace = backend.workspace as ContainedTurnKernelWorkspacePort;

  const assertOpen = (): void => {
    if (disposed) {throw new Error("contained turn workspace owner is disposed");}
  };

  const assertNativeIdentity = (input: Readonly<{
    operationId: ContainedTurnOperationId; workspaceId: ContainedTurnWorkspaceId;
  }>): void => {
    if (nativeState.native !== undefined && (ownedOperations.get(input.operationId) !== input.workspaceId ||
      ownedWorkspaces.get(input.workspaceId) !== input.operationId)) {
      throw new Error("contained turn native workspace request is not owned by this owner");
    }
  };

  const workspace: ContainedTurnKernelWorkspacePort = Object.freeze({
    close: (input: Parameters<ContainedTurnKernelWorkspacePort["close"]>[0]) => {
      assertOpen();
      assertNativeIdentity(input);
      return kernelWorkspace.close(input);
    },
    create: async (input: Parameters<ContainedTurnKernelWorkspacePort["create"]>[0]) => {
      assertOpen();
      const request = nativeState.reserve(input);
      const created = await kernelWorkspace.create(request);
      assertOpen();
      const workspaceId = created.workspaceId;
      const operationId = request.operationId;
      const existingWorkspace = ownedOperations.get(operationId);
      const existingOperation = ownedWorkspaces.get(workspaceId);
      if (
        (existingWorkspace !== undefined && existingWorkspace !== workspaceId) ||
        (existingOperation !== undefined && existingOperation !== operationId)
      ) {
        throw new Error("contained turn workspace owner creation identity conflicts with prior facts");
      }
      ownedOperations.set(operationId, workspaceId);
      ownedWorkspaces.set(workspaceId, operationId);
      return Object.freeze({ workspaceId });
    },
    ensureClosed: (input: Parameters<ContainedTurnKernelWorkspacePort["ensureClosed"]>[0]) => {
      assertOpen();
      assertNativeIdentity(input);
      return kernelWorkspace.ensureClosed(input);
    },
    quarantine: (input: Parameters<ContainedTurnKernelWorkspacePort["quarantine"]>[0]) => {
      assertOpen();
      assertNativeIdentity(input);
      return kernelWorkspace.quarantine(input);
    },
    queryClosure: (input: Parameters<ContainedTurnKernelWorkspacePort["queryClosure"]>[0]) => {
      assertOpen();
      assertNativeIdentity(input);
      return kernelWorkspace.queryClosure(input);
    },
  });

  const consumeLaunch = async <Result>(
    input: LaunchInput,
    launchAction: () => Promise<Result>,
  ): Promise<Result> => {
    assertOpen();
    if (
      ownedOperations.get(input.operationId) !== input.workspaceId ||
      ownedWorkspaces.get(input.workspaceId) !== input.operationId
    ) {
      throw new Error("contained turn workspace launch identity is not owned by this owner");
    }
    if (consumedAttempts.has(input.attemptId) || consumedWorkspaces.has(input.workspaceId)) {
      throw new Error("contained turn workspace launch authority is stale or already consumed");
    }
    consumedAttempts.add(input.attemptId);
    consumedWorkspaces.add(input.workspaceId);

    const launch = Promise.resolve().then(launchAction);
    activeLaunches.add(launch);
    try {
      return await launch;
    } finally {
      activeLaunches.delete(launch);
    }
  };

  const withLaunchAuthority: NodeContainedTurnWorkspaceOwner["withLaunchAuthority"] = (input, consume) => {
    if (nativeState.native !== undefined) {
      return Promise.reject(new Error("contained turn native workspace requires native launch consumption"));
    }
    return consumeLaunch(input, async () => {
      const resolved = await backend.resolveLaunchAuthority(input);
      return retention.consume({
        authority: resolved.authority,
        operationId: resolved.operationId,
        scope: resolved.scope,
        workspaceRef: resolved.workspaceRef,
      }, consume);
    });
  };

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) {return disposal;}
    disposed = true;
    // Revoke admission and outstanding borrows synchronously; already acquired
    // lease cleanup remains owned by the native backend.
    if (darwinWorkspace !== undefined && options.selectedNativeWorkspace !== undefined) {
      darwinWorkspace.revokeDarwinNativeWorkspaceSelection(options.selectedNativeWorkspace);
    }
    const launches = [...activeLaunches];
    disposal = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completed = launches.length === 0 || await Promise.race([
        Promise.allSettled(launches).then(() => true),
        new Promise<false>(resolve => {
          timeout = setTimeout(() => resolve(false), OWNER_DISPOSAL_COMPLETION_BOUND_MS);
        }),
      ]);
      if (timeout !== undefined) {clearTimeout(timeout);}
      await retention.dispose();
      if (!completed) {
        throw new Error(
          "contained turn workspace owner disposal incomplete: active launch authority did not settle",
        );
      }
    })();
    return disposal;
  };

  const owner = Object.freeze({ dispose, withLaunchAuthority, workspace });
  issuedOwners.set(owner, Object.freeze<OwnerPrivateFacts>({ native: nativeState.native !== undefined,
    readNativeClosure: nativeClosureReader(nativeState.native, ownedOperations, ownedWorkspaces),
    readNativeReceipts: nativeReceiptReader(nativeState.native, assertOpen, assertNativeIdentity),
    attachArtifacts: (roots, results) => nativeState.attachArtifacts(
      roots, results, assertOpen, operationId => ownedOperations.has(operationId),
    ),
    consumeNative: (input, consume) => {
      if (nativeState.native === undefined || options.selectedNativeWorkspace === undefined ||
        darwinWorkspace === undefined) {
        return Promise.reject(new Error("contained turn workspace owner has no selected native authority"));
      }
      const selection = options.selectedNativeWorkspace;
      const ids = Object.freeze({ ...input });
      return consumeLaunch(ids, () =>
        darwinWorkspace.withDarwinNativeWorkspaceSelection(selection, ids, consume));
    },
  }));
  return owner;
};
