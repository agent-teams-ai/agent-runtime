import { acquireAndPublish, type OperatorApproval } from './bootstrap.ts';
import type { PrivateAuthConfig } from './owner.ts';
import { createCodexCurrentKernelOwner, type CreateCodexCurrentKernelOwnerOptions, type HostHttpEgressSessionDependencies } from '@agent-teams/agent-execution/composition';
import { createDispatchAcceptanceFeature, type DispatchAcceptanceDependencies } from '@agent-teams/runtime-security/composition';
import type { RuntimeAccessHandle } from '../../../../src/composition/contained-turn-runtime-access.js';

type PA = Awaited<ReturnType<typeof acquireAndPublish>>;
type Kernel = ReturnType<typeof createCodexCurrentKernelOwner>;
type Security = ReturnType<typeof createDispatchAcceptanceFeature>;
/** Missing platform integration is an explicit callable, never a manufactured route capability.
 * Caller must own real Darwin preparation/session, AE store and current-authority ACL wiring,
 * host custody, qualification and public handle binding. No default exists at immutable e411.
 */
export interface DarwinJoin {
  readonly kernel: Omit<CreateCodexCurrentKernelOwnerOptions, 'postClaimPreparation'>;
  createSession(pa: PA): HostHttpEgressSessionDependencies;
  createPostClaimPreparation(input: Readonly<{pa: PA; session: HostHttpEgressSessionDependencies}>):
    NonNullable<CreateCodexCurrentKernelOwnerOptions['postClaimPreparation']>;
  readonly security: DispatchAcceptanceDependencies;
  finishDarwinRouteAndBindPublicHandle(input: Readonly<{pa: PA; kernel: Kernel; security: Security;
    session: HostHttpEgressSessionDependencies}>): Promise<Readonly<{handle: RuntimeAccessHandle; dispose(): Promise<void>}>>;
}
/** Executable conditional join. Acquire+publish is independently runnable without this seam.
 * Construction never declares a Darwin route qualified or invokes a model.
 */
export async function assembleWithDarwinJoin(pool: Parameters<typeof acquireAndPublish>[0], auth: PrivateAuthConfig,
  approval: OperatorApproval, join: DarwinJoin) {
  // Trusted composition inputs: capture each selected callback/value before any await.
  const {finishDarwinRouteAndBindPublicHandle: finish, createPostClaimPreparation: prepare,
    createSession, kernel: kernelInput, security: securityInput} = join;
  if (typeof finish !== 'function' || typeof prepare !== 'function' || typeof createSession !== 'function')
    {throw new Error('DARWIN_ROUTE_JOIN_REQUIRED');}
  const capturedKernel = {...kernelInput};
  const kernelOptions = {...capturedKernel, platformTarget: {...capturedKernel.platformTarget}};
  const securityOptions = {...securityInput};
  const config = Object.freeze({...auth});
  if (kernelOptions.platformTarget.platform !== 'darwin' || kernelOptions.platformTarget.architecture !== 'arm64')
    {throw new Error('DARWIN_ROUTE_JOIN_REQUIRED');}
  const pa = await acquireAndPublish(pool, config, approval);
  let kernel: Kernel | undefined;
  let closed = false, kernelRetired = false, paRetired = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let publicDispose: (() => Promise<void>) | undefined;
  let cleanup: Promise<void> | undefined;
  let hostCleanup: 'not-started' | 'pending' | 'settled' | 'failed' = 'not-started';
  const retireLocal = () => {
    closed = true; clearTimeout(expiry); config.signal.removeEventListener('abort', shutdown);
    // A trusted constructor can synchronously retire the lifetime before returning its owner.
    // Retire that late local product too, without calling any owner's cleanup twice.
    try {
      if (kernel && !kernelRetired) {
        kernelRetired = true;
        try {kernel.sealAdmission();} finally {kernel.dispose();}
      }
    } finally {if (!paRetired) {paRetired = true; pa.dispose();}}
  };
  const dispose = () => {
    // Seal synchronously, even if the foreign public disposer rejects or never settles.
    retireLocal();
    if (!cleanup) {
      hostCleanup = 'pending';
      cleanup = Promise.resolve().then(() => publicDispose?.()).then(
        // oxlint-disable-next-line promise/always-return -- this handler only records status; an explicit `return undefined` would itself violate unicorn/no-useless-undefined
        () => {hostCleanup = 'settled';}, error => {hostCleanup = 'failed'; throw error;});
    }
    // Keep the original failure available to callers, and observe it if shutdown is automatic.
    void cleanup.catch(() => {});
    return cleanup;
  };
  const check = () => {
    if (closed || config.signal.aborted || performance.now() >= config.deadline ||
        config.readGeneration() !== config.generation) {throw new Error('DARWIN_ASSEMBLY_REFUSED');}
  };
  const shutdown = () => {retireLocal(); if (publicDispose) {void dispose();}};
  config.signal.addEventListener('abort', shutdown, {once: true});
  expiry = setTimeout(shutdown, Math.max(1, Math.min(60000, config.deadline - performance.now())));
  expiry.unref();
  try {
    check();
    const session = createSession.call(join, pa);
    const postClaimPreparation = prepare.call(join, {pa, session});
    check(); if (!session || !postClaimPreparation) {throw new Error('DARWIN_ASSEMBLY_REFUSED');}
    kernel = createCodexCurrentKernelOwner({...kernelOptions, postClaimPreparation}); check();
    const security = createDispatchAcceptanceFeature(securityOptions); check();
    const publicOwner = await finish.call(join, {pa, kernel, security, session});
    // Retain returned, untransferred ownership before any authority/reflection refusal.
    const method = publicOwner.dispose;
    publicDispose = () => method.call(publicOwner);
    const handle = publicOwner.handle;
    check();
    return Object.freeze({handle, dispose, cleanupStatus: () => hostCleanup});
  } catch {
    // Never wait on an uncooperative public owner before retiring local resources or refusing.
    void dispose();
    throw Object.assign(new Error('DARWIN_ASSEMBLY_REFUSED'), {cleanup, cleanupStatus: () => hostCleanup});
  }
}
