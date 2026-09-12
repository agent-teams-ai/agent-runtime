// Private operator composition only; never an AE request or provider API.
import {acquireAndPublish, type OperatorApproval} from './bootstrap.ts';
import {HelperCleanupIndeterminate, type HelperObservation} from './auth-ipc.ts';
import type {PrivateAuthConfig} from './owner.ts';
type PA = Awaited<ReturnType<typeof acquireAndPublish>>;
export interface OperatorConfig {
  readonly pool: Parameters<typeof acquireAndPublish>[0];
  readonly auth: PrivateAuthConfig;
  readonly approval: OperatorApproval;
  withPublishedOwner(pa: PA): Promise<void>;
}
export type OperatorOutcome =
  | Readonly<{kind: 'completed'; message: 'MAC_PA_CALLBACK_COMPLETED'; exitCode: 0}>
  | Readonly<{kind: 'refused'; message: 'MAC_PA_REFUSED'; exitCode: 1}>
  | Readonly<{kind: 'helper-cleanup-indeterminate'; message: 'HELPER_CLEANUP_INDETERMINATE'; exitCode: 2;
      observation: HelperObservation}>;
export async function runTrustedOperator(input: OperatorConfig): Promise<OperatorOutcome> {
  let pa: PA | undefined;
  try {
    const {pool, auth, approval, withPublishedOwner} = input;
    // Capture getters once here; bootstrap sees only this captured policy record.
    const policy = {...approval};
    if(typeof withPublishedOwner !== 'function' || typeof policy.approveCapture !== 'function' ||
       policy.testSessionProvenance !== 'operator-owned-private-isolated-official-test-session') {throw new Error('MAC_PA_REFUSED');}
    pa = await acquireAndPublish(pool, auth, policy);
    await withPublishedOwner(pa);
    return Object.freeze({kind: 'completed', message: 'MAC_PA_CALLBACK_COMPLETED', exitCode: 0});
  } catch (error) {
    if(error instanceof HelperCleanupIndeterminate) {return Object.freeze({kind: 'helper-cleanup-indeterminate',
      message: 'HELPER_CLEANUP_INDETERMINATE', exitCode: 2, observation: error.observation});}
    return Object.freeze({kind: 'refused', message: 'MAC_PA_REFUSED', exitCode: 1});
  } finally {pa?.dispose();}
}
