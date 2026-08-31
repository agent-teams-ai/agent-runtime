import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  HostCustodyIngressOverflowError,
  HostCustodyLaunchRejectedError,
  type CustodiedProviderProcess,
  type CustodiedProviderProcessExit,
} from "./custodied-provider-process.js";
import {
  acquireVerifiedLaunchDescriptors,
  descriptorBoundArguments,
  descriptorBoundEnvironment,
} from "./host-custody-descriptor-launch.js";
import type { VerifiedLaunchDescriptors } from "./host-custody-launch.js";
import { NodeCustodiedSdkProcess } from "./host-custody-process-tree.js";
import { StableProcessGroupGuardian } from "./host-custody-stable-guardian.js";
import {
  boundedPromise,
  closeInput,
  HostStderrIngress,
  HostStdinEgress,
  HostStdoutIngress,
  writeBytes,
} from "./host-custody-stdio.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";

interface GuardedProviderLaunchOptions {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly live: LiveCustody;
  readonly maxDiagnosticBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStdinBytes: number;
  readonly maxStdoutBytes: number;
  readonly monotonicNow: () => number;
  readonly writeAfterMs: number;
  readonly onAbort: () => void;
  readonly onOverflow: () => void;
  readonly spawnAcknowledgementAfterMs: number;
  readonly stdoutHighWaterBytes: number;
}

export interface GuardedProviderLaunch {
  readonly authority: VerifiedLaunchDescriptors;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<CustodiedProviderProcessExit>;
  readonly guardian: StableProcessGroupGuardian;
  readonly process: CustodiedProviderProcess;
  readonly sdkProcess: NodeCustodiedSdkProcess;
  readonly stderr: HostStderrIngress;
  readonly stdout: HostStdoutIngress;
}

class DescriptorAuthorityAcquisitionError extends Error {}
class GuardianConstructionError extends Error {}

const descriptorFailureClass = (error: unknown): string => {
  if (!(error instanceof Error)) {return "UnknownDescriptorFailure";}
  if (error.message.includes("private root identity changed before spawn")) {return "PrivateRootPreSpawnFailure";}
  if (error.message.includes("private root")) {return "PrivateRootDescriptorFailure";}
  if (error.message.includes("private path") || error.message.includes("private descriptor")) {return "PrivatePathDescriptorFailure";}
  if (error.message.includes("workspace")) {return "WorkspaceDescriptorFailure";}
  if (error.message.includes("sealed executable")) {return "SealedExecutableFailure";}
  if (error.message.includes("executable")) {return "ExecutableDescriptorFailure";}
  return "UnknownDescriptorFailure";
};

export const launchGuardedProvider = (options: GuardedProviderLaunchOptions): GuardedProviderLaunch => {
  const { live } = options;
  let authority: VerifiedLaunchDescriptors;
  try {
    authority = acquireVerifiedLaunchDescriptors(
      live.plan!, live.executable!, live.workspaceRef, live.workspace!, live.privatePaths!,
    );
  } catch (error) {
    const failure = new DescriptorAuthorityAcquisitionError();
    failure.name = descriptorFailureClass(error);
    throw failure;
  }
  let guardian: StableProcessGroupGuardian;
  try {
    guardian = new StableProcessGroupGuardian({
      arguments: descriptorBoundArguments(options.arguments, live.workspaceRef, authority.workspaceDescriptor.childDescriptor),
      descriptors: authority,
      environment: descriptorBoundEnvironment(options.environment, authority.privatePathDescriptors),
      beforeLaunch: pid => live.residueAuthority?.attachGuardian(pid) ?? Promise.resolve(false),
      launchPermitted: () => !live.sealed,
    }, options.spawnAcknowledgementAfterMs);
  } catch {authority.close(); throw new GuardianConstructionError();}
  const child = guardian.child;
  const stdout = new HostStdoutIngress(options.stdoutHighWaterBytes, options.maxStdoutBytes, options.onOverflow);
  const stderr = new HostStderrIngress(options.maxStderrBytes, options.maxDiagnosticBytes, options.onOverflow);
  stdout.attach(child.stdout, guardian.streamFinal("stdout"));
  stderr.attach(child.stderr, guardian.streamFinal("stderr"));
  const exit = new Promise<CustodiedProviderProcessExit>(resolve => {
    guardian.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {resolve({ code, signal });});
  });
  const writeBounded = async (bytes: Uint8Array): Promise<void> => {
    const deadline = options.monotonicNow() + options.writeAfterMs;
    const acknowledgementRemaining = deadline - options.monotonicNow();
    if (acknowledgementRemaining <= 0) {throw new HostCustodyLaunchRejectedError();}
    const acknowledgement = await boundedPromise(
      live.spawnAcknowledgement ?? Promise.resolve("never-started" as const),
      acknowledgementRemaining,
    );
    if (options.monotonicNow() >= deadline) {throw new HostCustodyLaunchRejectedError();}
    if (acknowledgement !== "acknowledged" || live.identity.status !== "proved") {
      throw new HostCustodyLaunchRejectedError();
    }
    if (live.stdinBytes + bytes.byteLength > options.maxStdinBytes) {
      options.onOverflow();
      throw new HostCustodyIngressOverflowError();
    }
    live.stdinBytes += bytes.byteLength;
    const writeRemaining = deadline - options.monotonicNow();
    if (writeRemaining <= 0) {throw new HostCustodyLaunchRejectedError();}
    const written = await boundedPromise(
      writeBytes(child, bytes).then(() => true),
      writeRemaining,
    );
    if (written !== true || options.monotonicNow() >= deadline) {throw new HostCustodyLaunchRejectedError();}
  };
  const closeBounded = async (): Promise<void> => {
    const deadline = options.monotonicNow() + options.writeAfterMs;
    const remaining = deadline - options.monotonicNow();
    if (remaining <= 0) {throw new HostCustodyLaunchRejectedError();}
    const closed = await boundedPromise(
      closeInput(child).then(() => true),
      remaining,
    );
    if (closed !== true || options.monotonicNow() >= deadline) {throw new HostCustodyLaunchRejectedError();}
  };
  const sdkStdin = new HostStdinEgress(writeBounded, closeBounded);
  const process: CustodiedProviderProcess = Object.freeze({
    closeInput: closeBounded,
    custodyRef: live.custodyRef,
    workspaceAuthorityPath: "/proc/self/fd/4",
    stderr: stderr.diagnostic,
    stdout,
    waitForExit: () => exit,
    write: writeBounded,
  });
  const sdkProcess = new NodeCustodiedSdkProcess(guardian, sdkStdin, stdout, () => {
    options.onAbort();
    return true;
  });
  return Object.freeze({ authority, child, exit, guardian, process, sdkProcess, stderr, stdout });
};
