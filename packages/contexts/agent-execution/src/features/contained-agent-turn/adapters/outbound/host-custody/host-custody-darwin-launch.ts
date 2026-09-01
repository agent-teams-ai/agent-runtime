import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from "node:fs";

import type { HostCustodyLaunchPlan } from "./custodied-provider-process.js";
import {
  sha256,
  type ExecutableObservation,
  type PrivateLaunchPathObservations,
  type VerifiedLaunchDescriptors,
  type WorkspaceObservation,
} from "./host-custody-launch.js";

const directoryMatches = (actual: BigIntStats, expected: WorkspaceObservation): boolean =>
  actual.isDirectory() && actual.ctimeNs === expected.ctimeNs && actual.dev === expected.dev &&
  actual.ino === expected.ino && actual.mode === expected.mode && actual.uid === expected.uid;

const executableMatches = (actual: BigIntStats, expected: ExecutableObservation): boolean =>
  actual.isFile() && actual.ctimeNs === expected.ctimeNs && actual.dev === expected.dev &&
  actual.ino === expected.ino && actual.mode === expected.mode && actual.mtimeNs === expected.mtimeNs &&
  actual.nlink === expected.nlink && actual.size === expected.size;

const openDirectory = (path: string, retained = false): number => openSync(
  path,
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (retained ? 0 : (constants.O_NOFOLLOW ?? 0)),
);

/** Retains exact macOS-available descriptor/stat facts through guardian spawn. */
export const acquireDarwinLaunchAuthority = (
  plan: HostCustodyLaunchPlan,
  executable: ExecutableObservation,
  workspaceRef: string,
  workspace: WorkspaceObservation | Readonly<{
    observation: WorkspaceObservation;
    retainedDescriptorPath: string;
  }>,
  privatePaths: PrivateLaunchPathObservations,
): VerifiedLaunchDescriptors => {
  const workspaceObservation = "observation" in workspace ? workspace.observation : workspace;
  const retainedWorkspaceDescriptorPath = "observation" in workspace
    ? workspace.retainedDescriptorPath
    : undefined;
  if (plan.containmentProfile !== "cooperative-darwin-posix-process-group") {
    throw new Error("Darwin Host Custody profile mismatch");
  }
  const executableDescriptor = openSync(
    plan.executablePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let workspaceDescriptor: number | undefined;
  let privateRootDescriptor: number | undefined;
  const privateDescriptors: number[] = [];
  try {
    const executableStats = fstatSync(executableDescriptor, { bigint: true });
    if (!executableMatches(executableStats, executable) ||
        sha256(readFileSync(executableDescriptor)) !== executable.digest) {
      throw new Error("Host Custody executable identity changed immediately before spawn");
    }
    workspaceDescriptor = openDirectory(
      retainedWorkspaceDescriptorPath ?? workspaceRef,
      retainedWorkspaceDescriptorPath !== undefined,
    );
    if (!directoryMatches(fstatSync(workspaceDescriptor, { bigint: true }), workspaceObservation)) {
      throw new Error("Host Custody workspace identity changed immediately before spawn");
    }
    privateRootDescriptor = openDirectory(privatePaths.root.path);
    if (!directoryMatches(fstatSync(privateRootDescriptor, { bigint: true }), privatePaths.root)) {
      throw new Error("Host Custody private root identity changed immediately before spawn");
    }
    const privatePathDescriptors: Record<string, { readonly childDescriptor: number; readonly parentDescriptor: number }> = {};
    for (const key of privatePaths.environmentKeys) {
      const expected = privatePaths.byEnvironmentKey[key];
      if (expected === undefined) {throw new Error("Host Custody private path observation is missing");}
      const descriptor = openDirectory(expected.path);
      privateDescriptors.push(descriptor);
      if (!directoryMatches(fstatSync(descriptor, { bigint: true }), expected)) {
        throw new Error("Host Custody private path identity changed immediately before spawn");
      }
      privatePathDescriptors[key] = Object.freeze({ childDescriptor: 6 + privateDescriptors.length, parentDescriptor: descriptor });
    }
    let closed = false;
    return Object.freeze({
      close() {
        if (closed) {return;}
        closed = true;
        closeSync(executableDescriptor);
        closeSync(workspaceDescriptor as number);
        closeSync(privateRootDescriptor as number);
        for (const descriptor of privateDescriptors) {closeSync(descriptor);}
      },
      executable,
      executableDescriptor: Object.freeze({ childDescriptor: 5, parentDescriptor: executableDescriptor }),
      privatePathDescriptors: Object.freeze(privatePathDescriptors),
      privateRootDescriptor: Object.freeze({
        childDescriptor: 6 + privateDescriptors.length,
        parentDescriptor: privateRootDescriptor,
      }),
      workspaceDescriptor: Object.freeze({ childDescriptor: 4, parentDescriptor: workspaceDescriptor }),
    });
  } catch (error) {
    closeSync(executableDescriptor);
    if (workspaceDescriptor !== undefined) {closeSync(workspaceDescriptor);}
    if (privateRootDescriptor !== undefined) {closeSync(privateRootDescriptor);}
    for (const descriptor of privateDescriptors) {closeSync(descriptor);}
    throw error;
  }
};
